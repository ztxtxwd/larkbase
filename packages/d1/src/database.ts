/** @internal */
import type { Database as DbDatabase, Document, Filter, Table as DbTable, WithId } from '@larkflare/db'
import { D1Error } from './errors.js'
import {
  coerceForColumn,
  evaluate,
  evaluateConstant,
  literalValue,
  readValue,
  renderSqlValue,
  sqlCompare,
  sqlEquals,
  sqlTruth,
} from './evaluate.js'
import {
  SCHEMA_TABLE,
  ROWID_COLUMN,
  buildTableDefinition,
  columnMap,
  dbSchemaFor,
  resolveColumn,
  rowIdColumnOf,
  tableInfoColumns,
} from './schema.js'
import {
  containsAggregate,
  expressionKey,
  isAggregateName,
  normalizeIdentifier,
  parseOne,
  parseStatements,
  statementHasAggregates,
  walkExpr,
  type DeleteStatement,
  type InsertStatement,
  type SelectItem,
  type SelectStatement,
  type SqlExpr,
  type SqlStatement,
  type UpdateStatement,
} from './sql.js'
import { D1PreparedStatement } from './statement.js'
import { QueryScope, type ScopeEntry, type ScopeSource } from './scope.js'
import type {
  D1Column,
  D1ExecResult,
  D1Meta,
  D1Result,
  D1Row,
  D1TableDefinition,
  D1TableInfo,
} from './types.js'

type Row = Record<string, unknown> & { _id: string; __rowid: number }
type EvalRow = Record<string, unknown>

interface Group {
  rows: EvalRow[]
  first?: EvalRow
}

/** @internal Result plus the information `raw()` needs. */
export interface InternalExecution {
  result: D1Result
  columns: string[]
  raw: unknown[][]
}

export interface D1DatabaseOptions {
  /** Rows fetched per Bitable page. Defaults to 500. */
  pageSize?: number
}

const DEFAULT_PAGE_SIZE = 500
const MAX_ID_CHUNK = 100

/**
 * A relational database backed by one Larkflare DB (one Bitable Base). SQL
 * tables are DB tables; the D1 schema catalog lives in the reserved
 * `__d1_schema` table.
 */
export class D1Database {
  readonly name: string
  private readonly db: DbDatabase
  private readonly pageSize: number
  private readonly definitions = new Map<string, D1TableDefinition>()
  private readonly handles = new Map<string, DbTable<Document>>()
  private schemaTable?: DbTable<Document>
  private ready?: Promise<void>

  constructor(db: DbDatabase, options: D1DatabaseOptions = {}) {
    this.db = db
    this.name = db.name
    this.pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE))
  }

  /** Parse one statement without executing it. */
  prepare(sql: string): D1PreparedStatement {
    return new D1PreparedStatement(this, parseOne(sql), [])
  }

  /** Execute one or more semicolon-separated statements. */
  async exec(sql: string): Promise<D1ExecResult> {
    const statements = parseStatements(sql)
    const started = Date.now()
    for (const statement of statements) {
      await this.execute(statement, [])
    }
    return { count: statements.length, duration: Date.now() - started }
  }

  /**
   * Execute prepared statements in order. Bitable has no transactions, so a
   * failing statement does not roll back the ones before it.
   */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    if (!Array.isArray(statements)) throw new D1Error('batch() expects an array of prepared statements')
    const results: D1Result[] = []
    for (const statement of statements) {
      if (!(statement instanceof D1PreparedStatement)) {
        throw new D1Error('batch() expects D1PreparedStatement instances')
      }
      if (statement.database !== this) {
        throw new D1Error('batch() received a statement prepared against another database')
      }
      results.push((await statement.executeInternal()).result)
    }
    return results
  }

  /** Export the SQL schema and rows as a SQLite-style SQL dump. */
  async dump(): Promise<ArrayBuffer> {
    await this.ensureReady()
    const lines: string[] = []
    const definitions = [...this.definitions.values()].sort((a, b) =>
      normalizeIdentifier(a.name).localeCompare(normalizeIdentifier(b.name)),
    )
    for (const definition of definitions) {
      lines.push(`${definition.sql};`)
      const table = this.handleFor(definition)
      const documents = await this.readAll(table)
      const rows = await Promise.all(
        documents.map((document) => this.rowFromDocument(definition, document)),
      )
      rows.sort((a, b) => a.__rowid - b.__rowid)
      const columnList = definition.columns.map((column) => quote(column.name)).join(', ')
      for (const row of rows) {
        const values = definition.columns
          .map((column) => renderSqlValue(row[column.name]))
          .join(', ')
        lines.push(`INSERT INTO ${quote(definition.name)} (${columnList}) VALUES (${values});`)
      }
    }
    const buffer = Buffer.from(`${lines.join('\n')}\n`, 'utf8')
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  }

  /** List user tables and their declared columns. */
  async listTables(): Promise<D1TableInfo[]> {
    await this.ensureReady()
    const tables: D1TableInfo[] = []
    for (const definition of this.definitions.values()) {
      const meta = await this.db.tableMetadata(definition.name)
      const rowCount = meta ? meta.shards.reduce((sum, shard) => sum + (shard.rows || 0), 0) : 0
      tables.push({
        name: definition.name,
        columns: tableInfoColumns(definition),
        rowCount,
      })
    }
    return tables.sort((a, b) =>
      normalizeIdentifier(a.name).localeCompare(normalizeIdentifier(b.name)),
    )
  }

  /** @internal Execute one parsed statement. */
  async execute(statement: SqlStatement, params: unknown[]): Promise<InternalExecution> {
    await this.ensureReady()
    this.assertParams(statement, params)
    const started = Date.now()
    switch (statement.kind) {
      case 'create_table':
        return this.createTable(statement, started)
      case 'drop_table':
        return this.dropTable(statement, started)
      case 'insert':
        return this.insert(statement, params, started)
      case 'select':
        return this.select(statement, params, started)
      case 'update':
        return this.update(statement, params, started)
      case 'delete':
        return this.delete(statement, params, started)
    }
  }

  // -------------------------------------------------------------------------
  // Schema catalog
  // -------------------------------------------------------------------------

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.load().catch((err) => {
        this.ready = undefined
        throw err
      })
    }
    return this.ready
  }

  private async load(): Promise<void> {
    const schemaTable = this.db.defineTable(SCHEMA_TABLE, {
      columns: { type: 'json', spill: false },
      sql: 'text',
      created_at: 'date',
      updated_at: 'date',
    })
    this.schemaTable = schemaTable
    await schemaTable.ensure()
    const documents = await this.readAll(schemaTable)
    for (const document of documents) {
      const definition = parseStoredDefinition(document)
      if (!definition) continue
      this.definitions.set(normalizeIdentifier(definition.name), definition)
    }
  }

  private requireTable(name: string): D1TableDefinition {
    const definition = this.definitions.get(normalizeIdentifier(name))
    if (!definition) throw new D1Error(`no such table: ${name}`)
    return definition
  }

  private handleFor(definition: D1TableDefinition): DbTable<Document> {
    const key = normalizeIdentifier(definition.name)
    let handle = this.handles.get(key)
    if (!handle) {
      handle = this.db.defineTable(definition.name, dbSchemaFor(definition))
      this.handles.set(key, handle)
    }
    return handle
  }

  private async persistDefinition(definition: D1TableDefinition): Promise<void> {
    const schemaTable = this.schemaTable
    if (!schemaTable) throw new D1Error('schema catalog is not initialised')
    const key = normalizeIdentifier(definition.name)
    const payload = {
      name: definition.name,
      columns: definition.columns,
      sql: definition.sql,
      created_at: new Date(definition.createdAt),
      updated_at: new Date(),
    }
    const updated = await schemaTable.updateById(key, payload)
    if (updated.matchedCount === 0) {
      await schemaTable.insertOne({ _id: key, ...payload })
    }
    await schemaTable.flush()
  }

  private async createTable(statement: Extract<SqlStatement, { kind: 'create_table' }>, started: number): Promise<InternalExecution> {
    const definition = buildTableDefinition(statement)
    const key = normalizeIdentifier(definition.name)
    if (this.definitions.has(key)) {
      if (statement.ifNotExists) return this.finish(started, meta(), [], [], [])
      throw new D1Error(`table "${definition.name}" already exists`)
    }
    this.validateForeignKeys(definition)
    const handle = this.db.defineTable(definition.name, dbSchemaFor(definition))
    await handle.ensure()
    await this.persistDefinition(definition)
    this.definitions.set(key, definition)
    this.handles.set(key, handle)
    const resultMeta = meta()
    resultMeta.changed_db = true
    return this.finish(started, resultMeta, [], [], [])
  }

  private async dropTable(statement: Extract<SqlStatement, { kind: 'drop_table' }>, started: number): Promise<InternalExecution> {
    const key = normalizeIdentifier(statement.table)
    const definition = this.definitions.get(key)
    if (!definition) {
      if (statement.ifExists) return this.finish(started, meta(), [], [], [])
      throw new D1Error(`no such table: ${statement.table}`)
    }
    this.assertTableNotReferenced(definition)
    await this.db.dropTable(definition.name)
    this.definitions.delete(key)
    this.handles.delete(key)
    await this.schemaTable!.deleteMany({ _id: key })
    await this.schemaTable!.flush()
    const resultMeta = meta()
    resultMeta.changed_db = true
    return this.finish(started, resultMeta, [], [], [])
  }

  // -------------------------------------------------------------------------
  // INSERT
  // -------------------------------------------------------------------------

  private async insert(statement: InsertStatement, params: unknown[], started: number): Promise<InternalExecution> {
    const definition = this.requireTable(statement.table)
    const table = this.handleFor(definition)
    const target = this.resolveInsertColumns(definition, statement.columns)
    const rowIdColumn = rowIdColumnOf(definition)
    const resultMeta = meta()
    let nextRowId = await this.maxRowId(table)
    let lastRowId = 0
    let insertedCount = 0
    // A self-referencing row may point at a parent inserted earlier in the
    // same VALUES list. Insert those rows one at a time so the parent exists
    // by the time the child's foreign key is checked.
    const selfReferencing = definition.columns.some(
      (column) =>
        column.references !== undefined &&
        normalizeIdentifier(column.references.table) === normalizeIdentifier(definition.name),
    )

    const pending: Array<{ values: Map<string, unknown>; rowId: number }> = []

    for (const expressions of statement.rows) {
      if (expressions.length !== target.length) {
        throw new D1Error(
          `INSERT has ${expressions.length} value(s) for ${target.length} column(s) in table "${definition.name}"`,
        )
      }
      const provided = new Map<string, unknown>()
      for (let index = 0; index < target.length; index++) {
        const column = target[index]!
        provided.set(
          column.name,
          coerceForColumn(evaluate(expressions[index]!, { params }), column),
        )
      }

      const values = new Map<string, unknown>()
      for (const column of definition.columns) {
        if (provided.has(column.name)) {
          values.set(column.name, provided.get(column.name))
          continue
        }
        if (column.defaultExpr) {
          values.set(column.name, coerceForColumn(literalValue(column.defaultExpr), column))
        } else {
          values.set(column.name, null)
        }
      }

      let rowId: number
      let generatedRowId = false
      if (rowIdColumn) {
        const current = values.get(rowIdColumn.name)
        if (current === null || current === undefined) {
          rowId = ++nextRowId
          values.set(rowIdColumn.name, rowId)
          generatedRowId = true
        } else {
          rowId = Number(current)
          nextRowId = Math.max(nextRowId, rowId)
        }
      } else {
        rowId = ++nextRowId
      }

      for (const column of definition.columns) {
        const value = values.get(column.name)
        if ((value === null || value === undefined) && column.notNull) {
          throw new D1Error(`NOT NULL constraint failed: ${definition.name}.${column.name}`)
        }
      }

      for (const previous of pending) {
        this.assertNoBatchConflict(definition, values, previous.values)
      }
      if (!generatedRowId) {
        resultMeta.rows_read += await this.checkUnique(definition, table, values)
      } else {
        resultMeta.rows_read += await this.checkUnique(definition, table, values, {
          skip: rowIdColumn ? [rowIdColumn.name] : [],
        })
      }
      resultMeta.rows_read += await this.checkForeignKeys(definition, values)

      if (selfReferencing) {
        const document: Document = { [ROWID_COLUMN]: rowId }
        for (const column of definition.columns) {
          document[column.name] = values.get(column.name) ?? null
        }
        await table.insertOne(document)
        insertedCount++
        lastRowId = rowId
        continue
      }

      pending.push({ values, rowId })
    }

    if (pending.length > 0) {
      const documents: Document[] = pending.map(({ values, rowId }) => {
        const document: Document = { [ROWID_COLUMN]: rowId }
        for (const column of definition.columns) {
          document[column.name] = values.get(column.name) ?? null
        }
        return document
      })
      await table.insertMany(documents)
      lastRowId = pending[pending.length - 1]!.rowId
    }

    const totalInserted = insertedCount + pending.length
    if (totalInserted > 0) await table.flush()

    resultMeta.changes = totalInserted
    resultMeta.rows_written = totalInserted
    resultMeta.last_row_id = lastRowId
    resultMeta.changed_db = totalInserted > 0
    return this.finish(started, resultMeta, [], [], [])
  }

  private resolveInsertColumns(definition: D1TableDefinition, columns: string[] | undefined): D1Column[] {
    if (columns === undefined) return [...definition.columns]
    const resolved: D1Column[] = []
    const seen = new Set<string>()
    for (const name of columns) {
      const column = resolveColumn(definition, name)
      if (!column) throw new D1Error(`table "${definition.name}" has no column "${name}"`)
      if (seen.has(normalizeIdentifier(column.name))) {
        throw new D1Error(`column "${column.name}" appears twice in INSERT`)
      }
      seen.add(normalizeIdentifier(column.name))
      resolved.push(column)
    }
    return resolved
  }

  private assertNoBatchConflict(
    definition: D1TableDefinition,
    values: Map<string, unknown>,
    previous: Map<string, unknown>,
  ): void {
    for (const column of definition.columns) {
      if (!column.unique && !column.primaryKey) continue
      const value = values.get(column.name)
      if (value === null || value === undefined) continue
      if (sqlEquals(value, previous.get(column.name))) {
        throw new D1Error(`UNIQUE constraint failed: ${definition.name}.${column.name}`)
      }
    }
  }

  private async checkUnique(
    definition: D1TableDefinition,
    table: DbTable<Document>,
    values: Map<string, unknown>,
    options: { ignoreId?: string; skip?: string[] } = {},
  ): Promise<number> {
    let reads = 0
    for (const column of definition.columns) {
      if (!column.unique && !column.primaryKey) continue
      if (options.skip?.includes(column.name)) continue
      const value = values.get(column.name)
      if (value === null || value === undefined) continue
      const existing = await table.findOne(
        { [column.name]: value },
        { fields: ['_id'] },
      )
      reads++
      if (existing && existing._id !== options.ignoreId) {
        throw new D1Error(`UNIQUE constraint failed: ${definition.name}.${column.name}`)
      }
    }
    return reads
  }

  private validateForeignKeys(definition: D1TableDefinition): void {
    for (const column of definition.columns) {
      const reference = column.references
      if (!reference) continue
      const target =
        normalizeIdentifier(reference.table) === normalizeIdentifier(definition.name)
          ? definition
          : this.definitions.get(normalizeIdentifier(reference.table))
      if (!target) {
        throw new D1Error(
          `no such table: ${reference.table} (referenced by ${definition.name}.${column.name})`,
        )
      }
      let targetColumn: D1Column | undefined
      if (reference.column) {
        targetColumn = resolveColumn(target, reference.column)
        if (!targetColumn) {
          throw new D1Error(`no such column: ${reference.table}.${reference.column}`)
        }
      } else {
        const primaryKeys = target.columns.filter((candidate) => candidate.primaryKey)
        if (primaryKeys.length !== 1) {
          throw new D1Error(
            `REFERENCES ${target.name} needs an explicit column because the target has no single-column PRIMARY KEY`,
          )
        }
        targetColumn = primaryKeys[0]
      }
      if (!targetColumn) throw new D1Error(`cannot resolve the target of ${reference.table}`)
      if (!targetColumn.primaryKey && !targetColumn.unique) {
        throw new D1Error(
          `foreign key target ${target.name}.${targetColumn.name} must be PRIMARY KEY or UNIQUE`,
        )
      }
      column.references = { table: target.name, column: targetColumn.name }
    }
  }

  private async checkForeignKeys(
    definition: D1TableDefinition,
    values: Map<string, unknown>,
  ): Promise<number> {
    let reads = 0
    for (const column of definition.columns) {
      const reference = column.references
      if (!reference) continue
      const value = values.get(column.name)
      if (value === null || value === undefined) continue
      const target = this.definitions.get(normalizeIdentifier(reference.table))
      if (!target) throw new D1Error(`no such table: ${reference.table}`)
      const targetColumn = reference.column ? resolveColumn(target, reference.column) : undefined
      if (!targetColumn) {
        throw new D1Error(`no such column: ${reference.table}.${reference.column ?? ''}`)
      }
      const existing = await this.handleFor(target).findOne(
        { [targetColumn.name]: value },
        { fields: ['_id'] },
      )
      reads++
      if (!existing) {
        throw new D1Error(
          `FOREIGN KEY constraint failed: ${definition.name}.${column.name} -> ${target.name}.${targetColumn.name}`,
        )
      }
    }
    return reads
  }

  private referencedTargetColumns(definition: D1TableDefinition): D1Column[] {
    const found = new Map<string, D1Column>()
    for (const child of this.definitions.values()) {
      for (const column of child.columns) {
        const reference = column.references
        if (!reference || !reference.column) continue
        if (normalizeIdentifier(reference.table) !== normalizeIdentifier(definition.name)) continue
        const targetColumn = resolveColumn(definition, reference.column)
        if (targetColumn) found.set(normalizeIdentifier(targetColumn.name), targetColumn)
      }
    }
    return [...found.values()]
  }

  private async checkReferencedRows(
    target: D1TableDefinition,
    targetColumn: D1Column,
    value: unknown,
    ignoreIds: Set<string>,
  ): Promise<number> {
    if (value === null || value === undefined) return 0
    let reads = 0
    for (const child of this.definitions.values()) {
      for (const column of child.columns) {
        const reference = column.references
        if (!reference || !reference.column) continue
        if (normalizeIdentifier(reference.table) !== normalizeIdentifier(target.name)) continue
        if (normalizeIdentifier(reference.column) !== normalizeIdentifier(targetColumn.name)) continue
        const candidates = await this.handleFor(child)
          .find(
            { [column.name]: value },
            { limit: ignoreIds.size + 1, fields: ['_id'] },
          )
          .toArray()
        reads++
        if (candidates.some((candidate) => !ignoreIds.has(candidate._id))) {
          throw new D1Error(
            `FOREIGN KEY constraint failed: ${child.name}.${column.name} still references ${target.name}.${targetColumn.name}`,
          )
        }
      }
    }
    return reads
  }

  private assertTableNotReferenced(definition: D1TableDefinition): void {
    for (const child of this.definitions.values()) {
      if (child === definition) continue
      for (const column of child.columns) {
        const reference = column.references
        if (!reference) continue
        if (normalizeIdentifier(reference.table) !== normalizeIdentifier(definition.name)) continue
        throw new D1Error(
          `cannot drop table "${definition.name}": it is referenced by ${child.name}.${column.name}`,
        )
      }
    }
  }

  private async maxRowId(table: DbTable<Document>): Promise<number> {
    const last = await table
      .find({}, { limit: 1, fields: [ROWID_COLUMN] })
      .sort(ROWID_COLUMN, 'desc')
      .first()
    const value = Number(last?.[ROWID_COLUMN] ?? 0)
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  }

  // -------------------------------------------------------------------------
  // SELECT
  // -------------------------------------------------------------------------

  private async select(statement: SelectStatement, params: unknown[], started: number): Promise<InternalExecution> {
    const entries: ScopeEntry[] = []
    if (statement.table) {
      entries.push({
        definition: this.requireTable(statement.table),
        ...(statement.alias ? { alias: statement.alias } : {}),
      })
    }
    for (const join of statement.joins) {
      entries.push({
        definition: this.requireTable(join.table),
        ...(join.alias ? { alias: join.alias } : {}),
      })
    }
    const scope = new QueryScope(entries, entries.length > 1)

    for (let index = 0; index < statement.joins.length; index++) {
      const join = statement.joins[index]!
      if (!join.on) continue
      const onScope = scope.subScope(index + 2)
      this.validateScopeReferences(join.on, onScope)
      this.assertNoAggregates(join.on)
    }

    const aliases = selectAliases(statement.items)
    const groupBy = statement.groupBy.map((expr) => substituteAliases(expr, aliases))
    const having = statement.having ? substituteAliases(statement.having, aliases) : undefined
    const orderBy = statement.orderBy.map((order) => ({
      ...order,
      expr: substituteAliases(order.expr, aliases),
    }))
    const hasAggregates =
      statementHasAggregates(statement) ||
      groupBy.some((expr) => containsAggregate(expr)) ||
      (having !== undefined && containsAggregate(having)) ||
      orderBy.some((order) => containsAggregate(order.expr))
    const grouped = groupBy.length > 0 || hasAggregates || having !== undefined
    this.validateSelect(statement, scope, groupBy, having, orderBy, grouped)

    const groupKeys = new Set(groupBy.map((expr) => boundExpressionKey(expr, scope)))
    const groupedColumns = new Set<string>()
    for (const expr of groupBy) {
      if (expr.type !== 'column') continue
      const ref = scope.resolve(expr.name, expr.table)
      if (ref && ref !== 'ambiguous') groupedColumns.add(ref.rowKey)
    }

    if (grouped) {
      for (const item of statement.items) {
        if (item.kind === 'star') {
          throw new D1Error('SELECT * cannot be combined with GROUP BY or aggregate functions')
        }
        this.validateGroupedExpr(item.expr!, scope, groupKeys, groupedColumns)
      }
      if (having) this.validateGroupedExpr(having, scope, groupKeys, groupedColumns)
      for (const order of orderBy) {
        this.validateGroupedExpr(order.expr, scope, groupKeys, groupedColumns)
      }
    }

    let rows: EvalRow[]
    let scanned = 0
    if (scope.isEmpty) {
      rows = [{}]
    } else if (statement.joins.length === 0) {
      const read = await this.readRows(scope.sources[0]!.definition, statement.where, params, {
        columns: scope.map,
        skipValidation: true,
      })
      rows = read.rows
      scanned = read.scanned
    } else {
      const read = await this.readJoinedRows(statement, scope, params)
      rows = read.rows
      scanned = read.scanned
    }

    const limit = this.limitValue(statement.limit, params)
    const offset = this.offsetValue(statement.offset, params)

    if (grouped) {
      const groups = this.buildGroups(rows, groupBy, scope, params)
      let entriesWithProjection = groups.map((group) => ({
        group,
        projected: this.projectGroupRow(
          statement.items,
          group,
          scope,
          params,
          groupKeys,
          groupedColumns,
        ),
      }))

      if (having) {
        entriesWithProjection = entriesWithProjection.filter((entry) => {
          const value = this.evaluateGroupedValue(
            having,
            entry.group,
            scope,
            params,
            groupKeys,
            groupedColumns,
          )
          return sqlTruth(value) === true
        })
      }

      if (orderBy.length > 0) {
        const decorated = entriesWithProjection.map((entry, index) => ({
          entry,
          index,
          keys: orderBy.map((order) =>
            this.evaluateGroupedValue(
              order.expr,
              entry.group,
              scope,
              params,
              groupKeys,
              groupedColumns,
            ),
          ),
        }))
        decorated.sort((left, right) => compareSortKeys(left, right, orderBy))
        entriesWithProjection = decorated.map((entry) => entry.entry)
      }

      const sliced = entriesWithProjection.slice(
        offset,
        limit === undefined ? undefined : offset + limit,
      )
      const columns =
        sliced[0]?.projected.columns ?? this.selectColumns(statement.items, scope)
      let pairs = sliced.map((entry) => ({
        row: entry.projected.row,
        values: entry.projected.values,
      }))
      if (statement.distinct) pairs = distinctPairs(pairs)

      const resultMeta = meta()
      resultMeta.rows_read = scanned
      return this.finish(
        started,
        resultMeta,
        pairs.map((entry) => entry.row),
        columns,
        pairs.map((entry) => entry.values),
      )
    }

    const ordered = this.orderRows(rows, orderBy, scope, params)
    const sliced = ordered.slice(offset, limit === undefined ? undefined : offset + limit)
    const projected = sliced.map((row) => this.projectRow(statement.items, row, scope, params))
    const columns = projected[0]?.columns ?? this.selectColumns(statement.items, scope)

    let pairs = projected.map((entry) => ({ row: entry.row, values: entry.values }))
    if (statement.distinct) pairs = distinctPairs(pairs)

    const resultMeta = meta()
    resultMeta.rows_read = scanned
    return this.finish(
      started,
      resultMeta,
      pairs.map((entry) => entry.row),
      columns,
      pairs.map((entry) => entry.values),
    )
  }

  private async readJoinedRows(
    statement: SelectStatement,
    scope: QueryScope,
    params: unknown[],
  ): Promise<{ rows: EvalRow[]; scanned: number }> {
    const sourceRows: EvalRow[][] = []
    let scanned = 0
    for (const source of scope.sources) {
      const read = await this.readRows(source.definition, undefined, params)
      scanned += read.scanned
      sourceRows.push(read.rows.map((row) => this.compositeRow(source, row, scope)))
    }

    let rows = sourceRows[0] ?? []
    for (let index = 0; index < statement.joins.length; index++) {
      const join = statement.joins[index]!
      const source = scope.sources[index + 1]!
      const rightRows = sourceRows[index + 1] ?? []
      const onScope = scope.subScope(index + 2)
      const next: EvalRow[] = []
      for (const left of rows) {
        let matched = false
        for (const right of rightRows) {
          const combined = { ...left, ...right }
          if (
            join.type === 'cross' ||
            !join.on ||
            sqlTruth(evaluate(join.on, { params, row: combined, columns: onScope.map })) === true
          ) {
            next.push(combined)
            matched = true
          }
        }
        if (!matched && join.type === 'left') {
          const padded = { ...left }
          for (const column of source.definition.columns) {
            padded[scope.rowKey(source, column)] = null
          }
          next.push(padded)
        }
      }
      rows = next
    }

    if (statement.where) {
      rows = rows.filter(
        (row) =>
          sqlTruth(evaluate(statement.where!, { params, row, columns: scope.map })) === true,
      )
    }
    return { rows, scanned }
  }

  private compositeRow(source: ScopeSource, row: Row, scope: QueryScope): EvalRow {
    const out: EvalRow = {}
    for (const column of source.definition.columns) {
      out[scope.rowKey(source, column)] = row[column.name] ?? null
    }
    return out
  }

  private validateSelect(
    statement: SelectStatement,
    scope: QueryScope,
    groupBy: SqlExpr[],
    having: SqlExpr | undefined,
    orderBy: SelectStatement['orderBy'],
    grouped: boolean,
  ): void {
    for (const item of statement.items) {
      if (item.kind === 'star') {
        if (scope.isEmpty) throw new D1Error('SELECT * requires a FROM table')
        continue
      }
      this.validateScopeReferences(item.expr!, scope)
    }
    if (statement.where) {
      this.validateScopeReferences(statement.where, scope)
      this.assertNoAggregates(statement.where)
    }
    for (const expr of groupBy) {
      this.validateScopeReferences(expr, scope)
      this.assertNoAggregates(expr)
    }
    if (having) {
      this.validateScopeReferences(having, scope)
    }
    for (const order of orderBy) {
      this.validateScopeReferences(order.expr, scope)
      if (!grouped && containsAggregate(order.expr)) {
        throw new D1Error('aggregate functions are not allowed in ORDER BY')
      }
    }
    for (const expr of [statement.limit, statement.offset]) {
      if (!expr) continue
      this.validateNoColumns(expr)
    }
  }

  private validateScopeReferences(expr: SqlExpr, scope: QueryScope): void {
    walkExpr(expr, (node) => {
      if (node.type === 'column') {
        const ref = scope.resolve(node.name, node.table)
        if (ref === 'ambiguous') {
          throw new D1Error(`ambiguous column name: ${node.name}`)
        }
        if (!ref) {
          throw new D1Error(
            node.table ? `no such column: ${node.table}.${node.name}` : `no such column: ${node.name}`,
          )
        }
      }
      if (node.type === 'call' && !isAggregateName(node.name)) {
        throw new D1Error(`unknown function: ${node.name}`)
      }
    })
  }

  private validateGroupedExpr(
    expr: SqlExpr,
    scope: QueryScope,
    groupKeys: Set<string>,
    groupedColumns: Set<string>,
  ): void {
    if (expr.type === 'call' && isAggregateName(expr.name)) return
    if (expr.type === 'call') throw new D1Error(`unknown function: ${expr.name}`)
    if (groupKeys.has(boundExpressionKey(expr, scope))) return
    if (expr.type === 'column') {
      const ref = scope.resolve(expr.name, expr.table)
      if (ref === 'ambiguous') throw new D1Error(`ambiguous column name: ${expr.name}`)
      if (!ref) {
        throw new D1Error(
          expr.table ? `no such column: ${expr.table}.${expr.name}` : `no such column: ${expr.name}`,
        )
      }
      if (groupedColumns.has(ref.rowKey)) return
      throw new D1Error(
        `column "${expr.name}" must appear in GROUP BY or an aggregate function`,
      )
    }
    switch (expr.type) {
      case 'binary':
        this.validateGroupedExpr(expr.left, scope, groupKeys, groupedColumns)
        this.validateGroupedExpr(expr.right, scope, groupKeys, groupedColumns)
        break
      case 'unary':
        this.validateGroupedExpr(expr.operand, scope, groupKeys, groupedColumns)
        break
      case 'isNull':
        this.validateGroupedExpr(expr.operand, scope, groupKeys, groupedColumns)
        break
      case 'in':
        this.validateGroupedExpr(expr.operand, scope, groupKeys, groupedColumns)
        for (const value of expr.values) {
          this.validateGroupedExpr(value, scope, groupKeys, groupedColumns)
        }
        break
      case 'like':
        this.validateGroupedExpr(expr.operand, scope, groupKeys, groupedColumns)
        this.validateGroupedExpr(expr.pattern, scope, groupKeys, groupedColumns)
        break
      default:
        break
    }
  }

  private validateReferences(expr: SqlExpr, definition: D1TableDefinition | undefined): void {
    walkExpr(expr, (node) => {
      if (node.type === 'column') {
        if (!definition) throw new D1Error(`no such column: ${node.name} (SELECT has no FROM)`)
        if (
          node.table &&
          normalizeIdentifier(node.table) !== normalizeIdentifier(definition.name)
        ) {
          throw new D1Error(`no such table: ${node.table}`)
        }
        if (!resolveColumn(definition, node.name)) {
          throw new D1Error(`no such column: ${node.name}`)
        }
      }
      if (node.type === 'call' && !isAggregateName(node.name)) {
        throw new D1Error(`unknown function: ${node.name}`)
      }
    })
  }

  private validateNoColumns(expr: SqlExpr): void {
    walkExpr(expr, (node) => {
      if (node.type === 'column') {
        throw new D1Error(`column "${node.name}" is not allowed in this expression`)
      }
      if (node.type === 'call') throw new D1Error('function calls are not allowed here')
    })
  }

  private assertNoAggregates(expr: SqlExpr): void {
    walkExpr(expr, (node) => {
      if (node.type === 'call' && isAggregateName(node.name)) {
        throw new D1Error('aggregate functions are not allowed in WHERE')
      }
    })
  }

  private async readRows(
    definition: D1TableDefinition,
    where: SqlExpr | undefined,
    params: unknown[],
    options: { columns?: Map<string, string>; skipValidation?: boolean } = {},
  ): Promise<{ rows: Row[]; scanned: number }> {
    if (where && !options.skipValidation) this.validateReferences(where, definition)
    const filter = where ? this.pushdownFilter(where, definition, params) : undefined
    const table = this.handleFor(definition)
    const documents = await this.readAll(table, filter)
    const columns = options.columns ?? columnMap(definition)
    const rows: Row[] = []
    for (const document of documents) {
      const row = await this.rowFromDocument(definition, document)
      if (where) {
        const value = evaluate(where, { params, row, columns })
        if (sqlTruth(value) !== true) continue
      }
      rows.push(row)
    }
    return { rows, scanned: documents.length }
  }

  private pushdownFilter(
    expr: SqlExpr,
    definition: D1TableDefinition,
    params: unknown[],
  ): Filter | undefined {
    if (expr.type === 'binary' && expr.op === 'AND') {
      const left = this.pushdownFilter(expr.left, definition, params)
      const right = this.pushdownFilter(expr.right, definition, params)
      if (!left || !right) return undefined
      return { $and: [left, right] }
    }
    if (expr.type === 'isNull' && !expr.not && expr.operand.type === 'column') {
      const column = resolveColumn(definition, expr.operand.name)
      if (!column) return undefined
      return { [column.name]: null }
    }
    if (
      expr.type === 'in' &&
      !expr.not &&
      expr.operand.type === 'column' &&
      expr.values.every((value) => isConstant(value))
    ) {
      const column = resolveColumn(definition, expr.operand.name)
      if (!column) return undefined
      const values = expr.values.map((value) => evaluateConstant(value, params))
      if (values.length === 0) return undefined
      if (values.some((value) => value === null || isComplex(value))) return undefined
      return { [column.name]: { $in: values } }
    }
    if (
      expr.type === 'binary' &&
      ['=', '!=', '<', '<=', '>', '>='].includes(expr.op)
    ) {
      let columnName: string | undefined
      let valueExpr: SqlExpr | undefined
      let op = expr.op
      if (expr.left.type === 'column' && isConstant(expr.right)) {
        columnName = expr.left.name
        valueExpr = expr.right
      } else if (expr.right.type === 'column' && isConstant(expr.left)) {
        columnName = expr.right.name
        valueExpr = expr.left
        op = flipOperator(op)
      }
      if (!columnName || !valueExpr) return undefined
      const column = resolveColumn(definition, columnName)
      if (!column) return undefined
      const value = evaluateConstant(valueExpr, params)
      if (value === null || isComplex(value)) return undefined
      const operator = {
        '=': '$eq',
        '!=': '$ne',
        '<': '$lt',
        '<=': '$lte',
        '>': '$gt',
        '>=': '$gte',
      }[op]
      return { [column.name]: { [operator!]: value } }
    }
    return undefined
  }

  private async rowFromDocument(
    definition: D1TableDefinition,
    document: WithId<Document>,
  ): Promise<Row> {
    const row: Record<string, unknown> = {
      _id: document._id,
      __rowid: Number(document[ROWID_COLUMN] ?? 0) || 0,
    }
    for (const column of definition.columns) {
      row[column.name] = await readValue(document[column.name], column)
    }
    return row as Row
  }

  private async readAll(table: DbTable<Document>, filter: Filter = {}): Promise<Array<WithId<Document>>> {
    const documents: Array<WithId<Document>> = []
    let cursor: string | undefined
    for (;;) {
      const query = table.find(filter, { limit: this.pageSize, sort: '_id' })
      if (cursor !== undefined) query.after('_id', cursor)
      const page = await query.page()
      documents.push(...page.documents)
      if (!page.hasMore) break
      const last = page.documents[page.documents.length - 1]
      if (!last) break
      cursor = last._id
    }
    return documents
  }

  private orderRows(
    rows: EvalRow[],
    orderBy: SelectStatement['orderBy'],
    scope: QueryScope,
    params: unknown[],
  ): EvalRow[] {
    if (orderBy.length === 0) return rows
    const decorated = rows.map((row, index) => ({
      row,
      index,
      keys: orderBy.map((order) => evaluate(order.expr, { params, row, columns: scope.map })),
    }))
    decorated.sort((left, right) => compareSortKeys(left, right, orderBy))
    return decorated.map((entry) => entry.row)
  }

  private selectColumns(items: SelectItem[], scope: QueryScope): string[] {
    const columns: string[] = []
    for (const item of items) {
      if (item.kind === 'star') {
        if (scope.isEmpty) throw new D1Error('SELECT * requires a FROM table')
        columns.push(...scope.starColumns().map((column) => column.label))
      } else {
        columns.push(item.alias ?? expressionLabel(item.expr!, scope))
      }
    }
    return columns
  }

  private projectRow(
    items: SelectItem[],
    row: EvalRow,
    scope: QueryScope,
    params: unknown[],
  ): { row: D1Row; values: unknown[]; columns: string[] } {
    const values: unknown[] = []
    const columns: string[] = []
    for (const item of items) {
      if (item.kind === 'star') {
        if (scope.isEmpty) throw new D1Error('SELECT * requires a FROM table')
        for (const column of scope.starColumns()) {
          columns.push(column.label)
          values.push(row[column.rowKey] ?? null)
        }
        continue
      }
      columns.push(item.alias ?? expressionLabel(item.expr!, scope))
      values.push(evaluate(item.expr!, { params, row, columns: scope.map }))
    }
    const object = Object.fromEntries(columns.map((name, index) => [name, values[index]])) as D1Row
    return { row: object, values, columns }
  }

  private buildGroups(
    rows: EvalRow[],
    groupBy: SqlExpr[],
    scope: QueryScope,
    params: unknown[],
  ): Group[] {
    if (groupBy.length === 0) return [{ rows, ...(rows[0] ? { first: rows[0] } : {}) }]
    const groups = new Map<string, Group>()
    for (const row of rows) {
      const keys = groupBy.map((expr) => evaluate(expr, { params, row, columns: scope.map }))
      const key = rowKey(keys)
      let group = groups.get(key)
      if (!group) {
        group = { rows: [], first: row }
        groups.set(key, group)
      }
      group.rows.push(row)
    }
    return [...groups.values()]
  }

  private projectGroupRow(
    items: SelectItem[],
    group: Group,
    scope: QueryScope,
    params: unknown[],
    groupKeys: Set<string>,
    groupedColumns: Set<string>,
  ): { row: D1Row; values: unknown[]; columns: string[] } {
    const columns = this.selectColumns(items, scope)
    const values: unknown[] = []
    for (const item of items) {
      if (item.kind === 'star') {
        throw new D1Error('SELECT * cannot be combined with GROUP BY or aggregate functions')
      }
      values.push(
        this.evaluateGroupedValue(
          item.expr!,
          group,
          scope,
          params,
          groupKeys,
          groupedColumns,
        ),
      )
    }
    const row = Object.fromEntries(columns.map((name, index) => [name, values[index]])) as D1Row
    return { row, values, columns }
  }

  private evaluateGroupedValue(
    expr: SqlExpr,
    group: Group,
    scope: QueryScope,
    params: unknown[],
    groupKeys: Set<string>,
    groupedColumns: Set<string>,
  ): unknown {
    const columns = scope.map
    if (expr.type === 'call' && isAggregateName(expr.name)) {
      return this.aggregateCall(expr, group.rows, columns, params)
    }
    if (expr.type === 'call') throw new D1Error(`unknown function: ${expr.name}`)
    if (groupKeys.has(boundExpressionKey(expr, scope))) {
      if (!group.first) return null
      return evaluate(expr, { params, row: group.first, columns })
    }
    if (expr.type === 'column') {
      const ref = scope.resolve(expr.name, expr.table)
      if (ref === 'ambiguous') throw new D1Error(`ambiguous column name: ${expr.name}`)
      if (!ref) {
        throw new D1Error(
          expr.table ? `no such column: ${expr.table}.${expr.name}` : `no such column: ${expr.name}`,
        )
      }
      if (!groupedColumns.has(ref.rowKey)) {
        throw new D1Error(
          `column "${expr.name}" must appear in GROUP BY or an aggregate function`,
        )
      }
      if (!group.first) return null
      return evaluate(expr, { params, row: group.first, columns })
    }
    if (expr.type === 'literal' || expr.type === 'param') return evaluate(expr, { params })
    if (expr.type === 'binary') {
      const left = literalOf(
        this.evaluateGroupedValue(expr.left, group, scope, params, groupKeys, groupedColumns),
      )
      const right = literalOf(
        this.evaluateGroupedValue(expr.right, group, scope, params, groupKeys, groupedColumns),
      )
      return evaluate({ ...expr, left, right }, { params })
    }
    if (expr.type === 'unary') {
      const operand = literalOf(
        this.evaluateGroupedValue(expr.operand, group, scope, params, groupKeys, groupedColumns),
      )
      return evaluate({ ...expr, operand }, { params })
    }
    if (expr.type === 'isNull') {
      const operand = literalOf(
        this.evaluateGroupedValue(expr.operand, group, scope, params, groupKeys, groupedColumns),
      )
      return evaluate({ ...expr, operand }, { params })
    }
    if (expr.type === 'in') {
      const operand = literalOf(
        this.evaluateGroupedValue(expr.operand, group, scope, params, groupKeys, groupedColumns),
      )
      const values = expr.values.map((value) =>
        literalOf(
          this.evaluateGroupedValue(value, group, scope, params, groupKeys, groupedColumns),
        ),
      )
      return evaluate({ ...expr, operand, values }, { params })
    }
    if (expr.type === 'like') {
      const operand = literalOf(
        this.evaluateGroupedValue(expr.operand, group, scope, params, groupKeys, groupedColumns),
      )
      const pattern = literalOf(
        this.evaluateGroupedValue(expr.pattern, group, scope, params, groupKeys, groupedColumns),
      )
      return evaluate({ ...expr, operand, pattern }, { params })
    }
    throw new D1Error('unsupported expression in grouped SELECT')
  }

  private aggregateCall(
    expr: Extract<SqlExpr, { type: 'call' }>,
    rows: EvalRow[],
    columns: Map<string, string>,
    params: unknown[],
  ): unknown {
    const name = expr.name.toUpperCase()
    if (expr.star) {
      if (name !== 'COUNT') throw new D1Error(`${name}(*) is not supported`)
      return rows.length
    }
    if (expr.args.length !== 1) {
      throw new D1Error(`${name}() expects exactly one argument`)
    }
    const argument = expr.args[0]!
    const values = rows.map((row) => evaluate(argument, { params, row, columns }))
    if (name === 'COUNT') return values.filter((value) => value !== null && value !== undefined).length
    const present = values.filter((value) => value !== null && value !== undefined)
    if (present.length === 0) return null
    if (name === 'SUM' || name === 'AVG') {
      let total = 0
      for (const value of present) {
        const number = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)
        if (!Number.isFinite(number)) {
          throw new D1Error(`${name}() requires numeric values`)
        }
        total += number
      }
      return name === 'SUM' ? total : total / present.length
    }
    if (name === 'MIN' || name === 'MAX') {
      let winner = present[0]
      for (const value of present.slice(1)) {
        const cmp = sqlCompare(value, winner)
        if (cmp === null) continue
        if (name === 'MIN' ? cmp < 0 : cmp > 0) winner = value
      }
      return winner
    }
    throw new D1Error(`unknown aggregate function: ${expr.name}`)
  }

  private limitValue(expr: SqlExpr | undefined, params: unknown[]): number | undefined {
    if (!expr) return undefined
    const value = evaluateConstant(expr, params)
    if (value === null || value === undefined) return undefined
    const number = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)
    if (!Number.isFinite(number) || !Number.isInteger(number)) {
      throw new D1Error('LIMIT expects an integer')
    }
    if (number < 0) return undefined
    return number
  }

  private offsetValue(expr: SqlExpr | undefined, params: unknown[]): number {
    if (!expr) return 0
    const value = evaluateConstant(expr, params)
    if (value === null || value === undefined) return 0
    const number = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)
    if (!Number.isFinite(number) || !Number.isInteger(number)) {
      throw new D1Error('OFFSET expects an integer')
    }
    return Math.max(0, number)
  }

  // -------------------------------------------------------------------------
  // UPDATE / DELETE
  // -------------------------------------------------------------------------

  private async update(statement: UpdateStatement, params: unknown[], started: number): Promise<InternalExecution> {
    const definition = this.requireTable(statement.table)
    const table = this.handleFor(definition)
    const assignments = statement.assignments.map((assignment) => {
      const column = resolveColumn(definition, assignment.column)
      if (!column) throw new D1Error(`table "${definition.name}" has no column "${assignment.column}"`)
      this.validateReferences(assignment.value, definition)
      this.assertNoAggregates(assignment.value)
      return { column, value: assignment.value }
    })
    if (statement.where) {
      this.validateReferences(statement.where, definition)
      this.assertNoAggregates(statement.where)
    }

    const { rows, scanned } = await this.readRows(definition, statement.where, params)
    const columns = columnMap(definition)
    const referencedColumns = this.referencedTargetColumns(definition)
    let lastRowId = 0
    let reads = scanned
    for (const row of rows) {
      const patch: Document = {}
      const nextValues = new Map<string, unknown>()
      for (const column of definition.columns) {
        nextValues.set(column.name, row[column.name] ?? null)
      }
      for (const assignment of assignments) {
        const value = coerceForColumn(
          evaluate(assignment.value, { params, row, columns }),
          assignment.column,
        )
        nextValues.set(assignment.column.name, value)
        patch[assignment.column.name] = value
        if (assignment.column.name === definition.rowIdColumn) {
          patch[ROWID_COLUMN] = value
        }
      }
      reads += await this.checkUnique(definition, table, nextValues, { ignoreId: row._id })
      reads += await this.checkForeignKeys(definition, nextValues)
      for (const targetColumn of referencedColumns) {
        const before = row[targetColumn.name] ?? null
        const after = nextValues.get(targetColumn.name) ?? null
        if (sqlEquals(before, after)) continue
        reads += await this.checkReferencedRows(
          definition,
          targetColumn,
          before,
          new Set([row._id]),
        )
      }
      if (Object.keys(patch).length === 0) continue
      await table.updateById(row._id, patch)
      lastRowId = definition.rowIdColumn
        ? Number(nextValues.get(definition.rowIdColumn) ?? row.__rowid)
        : row.__rowid
    }
    if (rows.length > 0) await table.flush()

    const resultMeta = meta()
    resultMeta.changes = rows.length
    resultMeta.rows_read = reads
    resultMeta.rows_written = rows.length
    resultMeta.last_row_id = lastRowId
    resultMeta.changed_db = rows.length > 0
    return this.finish(started, resultMeta, [], [], [])
  }

  private async delete(statement: DeleteStatement, params: unknown[], started: number): Promise<InternalExecution> {
    const definition = this.requireTable(statement.table)
    const table = this.handleFor(definition)
    if (statement.where) {
      this.validateReferences(statement.where, definition)
      this.assertNoAggregates(statement.where)
    }
    const { rows, scanned } = await this.readRows(definition, statement.where, params)
    const ids = rows.map((row) => row._id)
    const deleting = new Set(ids)
    const referencedColumns = this.referencedTargetColumns(definition)
    let reads = scanned
    for (const row of rows) {
      for (const targetColumn of referencedColumns) {
        reads += await this.checkReferencedRows(
          definition,
          targetColumn,
          row[targetColumn.name] ?? null,
          deleting,
        )
      }
    }
    for (let offset = 0; offset < ids.length; offset += MAX_ID_CHUNK) {
      const chunk = ids.slice(offset, offset + MAX_ID_CHUNK)
      await table.deleteMany({ _id: { $in: chunk } })
    }
    if (ids.length > 0) await table.flush()

    const resultMeta = meta()
    resultMeta.changes = ids.length
    resultMeta.rows_read = reads
    resultMeta.rows_written = ids.length
    resultMeta.changed_db = ids.length > 0
    return this.finish(started, resultMeta, [], [], [])
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private assertParams(statement: SqlStatement, params: unknown[]): void {
    if (!Array.isArray(params)) throw new D1Error('bound parameters must be an array')
    if (params.length !== statement.paramCount) {
      throw new D1Error(
        `statement expects ${statement.paramCount} bound parameter(s), got ${params.length}`,
      )
    }
  }

  private finish(
    started: number,
    resultMeta: D1Meta,
    results: D1Row[],
    columns: string[],
    raw: unknown[][],
  ): InternalExecution {
    resultMeta.duration = Date.now() - started
    return { result: { success: true, results, meta: resultMeta }, columns, raw }
  }
}

function meta(): D1Meta {
  return {
    duration: 0,
    changes: 0,
    last_row_id: 0,
    changed_db: false,
    rows_read: 0,
    rows_written: 0,
  }
}

function isConstant(expr: SqlExpr): boolean {
  if (expr.type === 'column' || expr.type === 'call') return false
  if (expr.type === 'binary') return isConstant(expr.left) && isConstant(expr.right)
  if (expr.type === 'unary') return isConstant(expr.operand)
  if (expr.type === 'isNull') return isConstant(expr.operand)
  if (expr.type === 'in') return isConstant(expr.operand) && expr.values.every(isConstant)
  if (expr.type === 'like') return isConstant(expr.operand) && isConstant(expr.pattern)
  return true
}

function isComplex(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

function flipOperator(op: string): string {
  switch (op) {
    case '<':
      return '>'
    case '<=':
      return '>='
    case '>':
      return '<'
    case '>=':
      return '<='
    default:
      return op
  }
}

function literalOf(value: unknown): SqlExpr {
  return { type: 'literal', value: value as never }
}

function selectAliases(items: SelectItem[]): Map<string, SqlExpr> {
  const aliases = new Map<string, SqlExpr>()
  for (const item of items) {
    if (item.kind === 'expr' && item.alias) {
      aliases.set(normalizeIdentifier(item.alias), item.expr!)
    }
  }
  return aliases
}

function substituteAliases(expr: SqlExpr, aliases: Map<string, SqlExpr>): SqlExpr {
  if (expr.type === 'column' && !expr.table) {
    const replacement = aliases.get(normalizeIdentifier(expr.name))
    if (replacement) return replacement
  }
  switch (expr.type) {
    case 'binary':
      return {
        ...expr,
        left: substituteAliases(expr.left, aliases),
        right: substituteAliases(expr.right, aliases),
      }
    case 'unary':
      return { ...expr, operand: substituteAliases(expr.operand, aliases) }
    case 'isNull':
      return { ...expr, operand: substituteAliases(expr.operand, aliases) }
    case 'in':
      return {
        ...expr,
        operand: substituteAliases(expr.operand, aliases),
        values: expr.values.map((value) => substituteAliases(value, aliases)),
      }
    case 'like':
      return {
        ...expr,
        operand: substituteAliases(expr.operand, aliases),
        pattern: substituteAliases(expr.pattern, aliases),
      }
    case 'call':
      return { ...expr, args: expr.args.map((arg) => substituteAliases(arg, aliases)) }
    default:
      return expr
  }
}

function compareSortKeys(
  left: { keys: unknown[]; index: number },
  right: { keys: unknown[]; index: number },
  orderBy: SelectStatement['orderBy'],
): number {
  for (let index = 0; index < orderBy.length; index++) {
    const direction = orderBy[index]!.direction
    const a = left.keys[index]
    const b = right.keys[index]
    const aNull = a === null || a === undefined
    const bNull = b === null || b === undefined
    if (aNull && bNull) continue
    if (aNull) return direction === 'ASC' ? -1 : 1
    if (bNull) return direction === 'ASC' ? 1 : -1
    const cmp = sqlCompare(a, b)
    if (cmp !== null && cmp !== 0) return direction === 'ASC' ? cmp : -cmp
  }
  return left.index - right.index
}

function distinctPairs<T extends { values: unknown[] }>(pairs: T[]): T[] {
  const seen = new Set<string>()
  return pairs.filter((pair) => {
    const key = rowKey(pair.values)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function expressionLabel(expr: SqlExpr, scope: QueryScope): string {
  switch (expr.type) {
    case 'column': {
      const ref = scope.resolve(expr.name, expr.table)
      return ref && ref !== 'ambiguous' ? ref.column.name : expr.name
    }
    case 'literal':
      if (expr.value === null) return 'NULL'
      if (typeof expr.value === 'string') return `'${expr.value}'`
      return String(expr.value)
    case 'param':
      return `?${expr.index}`
    case 'call':
      return `${expr.name.toUpperCase()}(${expr.star ? '*' : expr.args.map((arg) => expressionLabel(arg, scope)).join(', ')})`
    case 'unary':
      return `${expr.op} ${expressionLabel(expr.operand, scope)}`
    case 'binary':
      return `${expressionLabel(expr.left, scope)} ${expr.op} ${expressionLabel(expr.right, scope)}`
    case 'isNull':
      return `${expressionLabel(expr.operand, scope)} IS ${expr.not ? 'NOT ' : ''}NULL`
    case 'in':
      return `${expressionLabel(expr.operand, scope)} ${expr.not ? 'NOT ' : ''}IN (...)`
    case 'like':
      return `${expressionLabel(expr.operand, scope)} ${expr.not ? 'NOT ' : ''}LIKE ${expressionLabel(expr.pattern, scope)}`
  }
}

/** Like `expressionKey`, but resolves column names to scope row keys first. */
function boundExpressionKey(expr: SqlExpr, scope: QueryScope): string {
  switch (expr.type) {
    case 'column': {
      const ref = scope.resolve(expr.name, expr.table)
      if (!ref || ref === 'ambiguous') return expressionKey(expr)
      return `col:${ref.rowKey}`
    }
    case 'binary':
      return `bin:${expr.op}:${boundExpressionKey(expr.left, scope)}:${boundExpressionKey(expr.right, scope)}`
    case 'unary':
      return `un:${expr.op}:${boundExpressionKey(expr.operand, scope)}`
    case 'isNull':
      return `null:${expr.not ? 1 : 0}:${boundExpressionKey(expr.operand, scope)}`
    case 'in':
      return `in:${expr.not ? 1 : 0}:${boundExpressionKey(expr.operand, scope)}:${expr.values
        .map((value) => boundExpressionKey(value, scope))
        .join(',')}`
    case 'like':
      return `like:${expr.not ? 1 : 0}:${boundExpressionKey(expr.operand, scope)}:${boundExpressionKey(expr.pattern, scope)}`
    case 'call':
      return `call:${normalizeIdentifier(expr.name)}:${expr.star ? '*' : expr.args.map((arg) => boundExpressionKey(arg, scope)).join(',')}`
    default:
      return expressionKey(expr)
  }
}

function rowKey(values: unknown[]): string {
  return values
    .map((value) => {
      if (value === null || value === undefined) return 'n'
      if (typeof value === 'number') return `d:${value}`
      if (typeof value === 'string') return `s:${value}`
      if (typeof value === 'boolean') return `b:${value}`
      if (value instanceof ArrayBuffer) return `x:${Buffer.from(value).toString('hex')}`
      if (value instanceof Uint8Array) return `x:${Buffer.from(value).toString('hex')}`
      try {
        return `j:${JSON.stringify(value)}`
      } catch {
        return `o:${String(value)}`
      }
    })
    .join('\u0001')
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function parseStoredDefinition(document: WithId<Document>): D1TableDefinition | null {
  const name = typeof document.name === 'string' ? document.name : ''
  if (!name || !Array.isArray(document.columns)) return null
  const columns = document.columns as D1Column[]
  const primary = columns.find((column) => column.primaryKey && column.type === 'INTEGER')
  const createdAt =
    document.created_at instanceof Date
      ? document.created_at.getTime()
      : Number(document.created_at ?? 0) || 0
  return {
    name,
    columns,
    sql: typeof document.sql === 'string' ? document.sql : '',
    ...(primary ? { rowIdColumn: primary.name } : {}),
    createdAt,
  }
}
