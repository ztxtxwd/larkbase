import type { SchemaDefinition, SchemaFieldType } from '@larkflare/db'
import { D1Error } from './errors.js'
import { coerceForColumn, literalValue } from './evaluate.js'
import {
  normalizeIdentifier,
  normalizeSqlType,
  renderCreateTable,
  type ColumnSpec,
  type CreateTableStatement,
} from './sql.js'
import type { D1Column, D1ColumnType, D1TableDefinition } from './types.js'

/** DB table holding the D1 schema catalog inside each database Base. */
export const SCHEMA_TABLE = '__d1_schema'
/** Hidden number column allocated for every row. */
export const ROWID_COLUMN = '__rowid'

const RESERVED_COLUMNS = new Set(['_id', ROWID_COLUMN, '__proto__'])

export function buildTableDefinition(statement: CreateTableStatement): D1TableDefinition {
  if (normalizeIdentifier(statement.table) === normalizeIdentifier(SCHEMA_TABLE)) {
    throw new D1Error(`table name "${SCHEMA_TABLE}" is reserved`)
  }
  if (statement.table.includes('#')) {
    throw new D1Error('table names cannot contain "#" because DB uses it for shard suffixes')
  }
  if (statement.columns.length === 0) {
    throw new D1Error(`table "${statement.table}" needs at least one column`)
  }

  const seen = new Set<string>()
  const columns: D1Column[] = []
  let primaryKey: D1Column | undefined

  for (const spec of statement.columns) {
    if (RESERVED_COLUMNS.has(normalizeIdentifier(spec.name))) {
      throw new D1Error(`column name "${spec.name}" is reserved`)
    }
    const key = normalizeIdentifier(spec.name)
    if (seen.has(key)) throw new D1Error(`duplicate column name "${spec.name}"`)
    seen.add(key)

    const column = normalizeColumn(spec)
    if (column.primaryKey) {
      if (primaryKey) throw new D1Error('a table may declare only one PRIMARY KEY column')
      primaryKey = column
    }
    columns.push(column)
  }

  if (primaryKey && primaryKey.autoIncrement && primaryKey.type !== 'INTEGER') {
    throw new D1Error('AUTOINCREMENT requires an INTEGER PRIMARY KEY column')
  }

  for (const column of columns) {
    if ((column.unique || column.primaryKey) && (column.type === 'BLOB' || column.type === 'JSON')) {
      throw new D1Error(`UNIQUE / PRIMARY KEY is not supported on ${column.type} column "${column.name}"`)
    }
    if (column.defaultExpr) {
      const literal = literalValue(column.defaultExpr)
      coerceForColumn(literal, column)
    }
  }

  return {
    name: statement.table,
    columns,
    sql: renderCreateTable(statement.table, statement.columns),
    ...(primaryKey && primaryKey.type === 'INTEGER' ? { rowIdColumn: primaryKey.name } : {}),
    createdAt: Date.now(),
  }
}

function normalizeColumn(spec: ColumnSpec): D1Column {
  const type = normalizeSqlType(spec.declaredType)
  return {
    name: spec.name,
    type,
    declaredType: spec.declaredType,
    primaryKey: spec.primaryKey,
    autoIncrement: spec.autoIncrement,
    notNull: spec.notNull || spec.primaryKey,
    unique: spec.unique || spec.primaryKey,
    ...(spec.defaultExpr ? { defaultExpr: spec.defaultExpr } : {}),
    ...(spec.references ? { references: { ...spec.references } } : {}),
  }
}

export function dbSchemaFor(table: D1TableDefinition): SchemaDefinition {
  const schema: SchemaDefinition = { [ROWID_COLUMN]: 'number' }
  for (const column of table.columns) {
    schema[column.name] = dbKind(column.type)
  }
  return schema
}

function dbKind(type: D1ColumnType): SchemaFieldType {
  switch (type) {
    case 'INTEGER':
    case 'REAL':
    case 'NUMERIC':
      return 'number'
    case 'TEXT':
      return 'text'
    case 'BLOB':
      return 'blob'
    case 'BOOLEAN':
      return 'boolean'
    case 'JSON':
      return 'json'
  }
}

export function columnMap(table: D1TableDefinition): Map<string, string> {
  const map = new Map<string, string>()
  for (const column of table.columns) {
    map.set(normalizeIdentifier(column.name), column.name)
    map.set(`${normalizeIdentifier(table.name)}\u0001${normalizeIdentifier(column.name)}`, column.name)
  }
  return map
}

export function resolveColumn(table: D1TableDefinition, name: string): D1Column | undefined {
  const normalized = normalizeIdentifier(name)
  return table.columns.find((column) => normalizeIdentifier(column.name) === normalized)
}

export function rowIdColumnOf(table: D1TableDefinition): D1Column | undefined {
  if (!table.rowIdColumn) return undefined
  return resolveColumn(table, table.rowIdColumn)
}

export function tableInfoColumns(table: D1TableDefinition): Array<{
  name: string
  type: D1ColumnType
  primaryKey: boolean
  notNull: boolean
  unique: boolean
}> {
  return table.columns.map((column) => ({
    name: column.name,
    type: column.type,
    primaryKey: column.primaryKey,
    notNull: column.notNull,
    unique: column.unique,
  }))
}
