/**
 * A deliberately small SQL front end for Larkflare D1.
 *
 * Supported statements:
 *   CREATE TABLE [IF NOT EXISTS], DROP TABLE [IF EXISTS],
 *   INSERT INTO ... VALUES, SELECT, UPDATE, DELETE
 *
 * Supported expressions: literals, `?` parameters, column references,
 * AND / OR / NOT, comparison operators, IN, LIKE, IS [NOT] NULL,
 * arithmetic (+ - * / %), string concatenation (||), parentheses and the
 * aggregate calls COUNT / SUM / AVG / MIN / MAX.
 *
 * Everything else is rejected with a clear error rather than silently
 * producing a different result. Bitable is the storage engine; this parser
 * only gives it relational, SQL-shaped semantics.
 */
import { D1SyntaxError } from './errors.js'

/** SQLite-style storage affinity used by a D1 column. */
export type D1ColumnType = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'BOOLEAN' | 'NUMERIC' | 'JSON'

export type SqlLiteral = string | number | boolean | null

export type SqlExpr =
  | { type: 'literal'; value: SqlLiteral }
  | { type: 'param'; index: number }
  | { type: 'column'; name: string; table?: string }
  | { type: 'binary'; op: string; left: SqlExpr; right: SqlExpr }
  | { type: 'unary'; op: string; operand: SqlExpr }
  | { type: 'isNull'; operand: SqlExpr; not: boolean }
  | { type: 'in'; operand: SqlExpr; values: SqlExpr[]; not: boolean }
  | { type: 'like'; operand: SqlExpr; pattern: SqlExpr; not: boolean }
  | { type: 'call'; name: string; args: SqlExpr[]; star?: boolean }

export interface SelectItem {
  kind: 'star' | 'expr'
  expr?: SqlExpr
  alias?: string
}

export interface OrderItem {
  expr: SqlExpr
  direction: 'ASC' | 'DESC'
}

export interface ColumnSpec {
  name: string
  declaredType: string
  primaryKey: boolean
  autoIncrement: boolean
  notNull: boolean
  unique: boolean
  defaultExpr?: SqlExpr
  references?: { table: string; column?: string }
}

export interface CreateTableStatement {
  kind: 'create_table'
  table: string
  ifNotExists: boolean
  columns: ColumnSpec[]
  paramCount: number
}

export interface DropTableStatement {
  kind: 'drop_table'
  table: string
  ifExists: boolean
  paramCount: number
}

export interface InsertStatement {
  kind: 'insert'
  table: string
  columns?: string[]
  rows: SqlExpr[][]
  paramCount: number
}

export interface JoinClause {
  type: 'inner' | 'left' | 'cross'
  table: string
  alias?: string
  on?: SqlExpr
}

export interface SelectStatement {
  kind: 'select'
  distinct: boolean
  items: SelectItem[]
  table?: string
  alias?: string
  joins: JoinClause[]
  where?: SqlExpr
  groupBy: SqlExpr[]
  having?: SqlExpr
  orderBy: OrderItem[]
  limit?: SqlExpr
  offset?: SqlExpr
  paramCount: number
}

export interface UpdateStatement {
  kind: 'update'
  table: string
  assignments: Array<{ column: string; value: SqlExpr }>
  where?: SqlExpr
  paramCount: number
}

export interface DeleteStatement {
  kind: 'delete'
  table: string
  where?: SqlExpr
  paramCount: number
}

export type SqlStatement =
  | CreateTableStatement
  | DropTableStatement
  | InsertStatement
  | SelectStatement
  | UpdateStatement
  | DeleteStatement

const KEYWORDS = new Set([
  'ALL',
  'ALTER',
  'AND',
  'AS',
  'ASC',
  'AUTOINCREMENT',
  'BEGIN',
  'BY',
  'CHECK',
  'COLLATE',
  'COMMIT',
  'CONSTRAINT',
  'CREATE',
  'CROSS',
  'DEFAULT',
  'DELETE',
  'DESC',
  'DISTINCT',
  'DROP',
  'EXISTS',
  'FALSE',
  'FROM',
  'FULL',
  'GROUP',
  'HAVING',
  'IF',
  'IN',
  'INNER',
  'INSERT',
  'INTO',
  'IS',
  'JOIN',
  'KEY',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NATURAL',
  'NOT',
  'NULL',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'PRIMARY',
  'REFERENCES',
  'RETURNING',
  'RIGHT',
  'ROLLBACK',
  'SELECT',
  'SET',
  'TABLE',
  'TRANSACTION',
  'TRUE',
  'UNION',
  'UNIQUE',
  'UPDATE',
  'USING',
  'VALUES',
  'WHERE',
])

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])

export function isAggregateName(name: string): boolean {
  return AGGREGATES.has(name.toUpperCase())
}

type TokenType = 'ident' | 'keyword' | 'number' | 'string' | 'param' | 'op' | 'punct' | 'eof'

interface Token {
  type: TokenType
  value: string
  position: number
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isIdentStart(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    ch === '_' ||
    ch.charCodeAt(0) >= 0x80
  )
}

function isIdentPart(ch: string | undefined): boolean {
  return isIdentStart(ch) || isDigit(ch) || ch === '$'
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < sql.length) {
    const ch = sql[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i++
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) throw new D1SyntaxError('unterminated block comment', i)
      i = end + 2
      continue
    }
    if (ch === "'") {
      const start = i
      i++
      let value = ''
      for (;;) {
        if (i >= sql.length) throw new D1SyntaxError('unterminated string literal', start)
        const c = sql[i]!
        if (c === "'") {
          if (sql[i + 1] === "'") {
            value += "'"
            i += 2
            continue
          }
          i++
          break
        }
        value += c
        i++
      }
      tokens.push({ type: 'string', value, position: start })
      continue
    }
    if (ch === '"' || ch === '`') {
      const quote = ch
      const start = i
      i++
      let value = ''
      for (;;) {
        if (i >= sql.length) throw new D1SyntaxError('unterminated quoted identifier', start)
        const c = sql[i]!
        if (c === quote) {
          if (sql[i + 1] === quote) {
            value += quote
            i += 2
            continue
          }
          i++
          break
        }
        value += c
        i++
      }
      tokens.push({ type: 'ident', value, position: start })
      continue
    }
    if (ch === '[') {
      const start = i
      const end = sql.indexOf(']', i + 1)
      if (end === -1) throw new D1SyntaxError('unterminated quoted identifier', start)
      tokens.push({ type: 'ident', value: sql.slice(i + 1, end), position: start })
      i = end + 1
      continue
    }
    if (ch === '?') {
      const start = i
      i++
      while (isDigit(sql[i])) i++
      tokens.push({ type: 'param', value: sql.slice(start, i), position: start })
      continue
    }
    if (isDigit(ch) || (ch === '.' && isDigit(sql[i + 1]))) {
      const start = i
      if (ch === '.') i++
      while (isDigit(sql[i])) i++
      if (sql[i] === '.') {
        i++
        while (isDigit(sql[i])) i++
      }
      if (sql[i] === 'e' || sql[i] === 'E') {
        i++
        if (sql[i] === '+' || sql[i] === '-') i++
        while (isDigit(sql[i])) i++
      }
      tokens.push({ type: 'number', value: sql.slice(start, i), position: start })
      continue
    }
    if (isIdentStart(ch)) {
      const start = i
      i++
      while (isIdentPart(sql[i])) i++
      const value = sql.slice(start, i)
      const upper = value.toUpperCase()
      tokens.push({
        type: KEYWORDS.has(upper) ? 'keyword' : 'ident',
        value: KEYWORDS.has(upper) ? upper : value,
        position: start,
      })
      continue
    }

    const two = sql.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '==' || two === '||') {
      tokens.push({ type: 'op', value: two === '==' ? '=' : two, position: i })
      i += 2
      continue
    }
    if ('=<>+-*/%'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, position: i })
      i++
      continue
    }
    if ('(),;.'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, position: i })
      i++
      continue
    }
    throw new D1SyntaxError(`unexpected character ${JSON.stringify(ch)}`, i)
  }

  tokens.push({ type: 'eof', value: '', position: sql.length })
  return tokens
}

export function normalizeIdentifier(name: string): string {
  return name.toLowerCase()
}

export function normalizeSqlType(declaredType: string): D1ColumnType {
  const type = declaredType.toUpperCase()
  if (type.includes('BOOL')) return 'BOOLEAN'
  if (type.includes('JSON')) return 'JSON'
  if (type.includes('INT')) return 'INTEGER'
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'TEXT'
  if (type.includes('BLOB')) return 'BLOB'
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

class Parser {
  private index = 0
  private paramCount = 0

  constructor(private readonly tokens: Token[]) {}

  parseStatement(): SqlStatement {
    this.paramCount = 0
    if (this.isKeyword('CREATE')) return this.parseCreateTable()
    if (this.isKeyword('DROP')) return this.parseDropTable()
    if (this.isKeyword('INSERT')) return this.parseInsert()
    if (this.isKeyword('SELECT')) return this.parseSelect()
    if (this.isKeyword('UPDATE')) return this.parseUpdate()
    if (this.isKeyword('DELETE')) return this.parseDelete()

    const token = this.peek()
    if (this.isKeyword('ALTER')) {
      throw new D1SyntaxError('ALTER TABLE is not supported; create a new table and copy the rows', token.position)
    }
    if (token.type === 'keyword' && ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(token.value)) {
      throw new D1SyntaxError('transactions are not supported by Larkflare D1', token.position)
    }
    throw new D1SyntaxError(`unsupported statement starting with ${token.value || '<eof>'}`, token.position)
  }

  atEnd(): boolean {
    return this.peek().type === 'eof'
  }

  matchSemicolon(): boolean {
    if (this.peek().type === 'punct' && this.peek().value === ';') {
      this.index++
      return true
    }
    return false
  }

  private parseCreateTable(): CreateTableStatement {
    this.expectKeyword('CREATE')
    this.expectKeyword('TABLE')
    let ifNotExists = false
    if (this.matchKeyword('IF')) {
      this.expectKeyword('NOT')
      this.expectKeyword('EXISTS')
      ifNotExists = true
    }
    const table = this.parseName()
    this.expectPunct('(')
    const columns: ColumnSpec[] = []
    for (;;) {
      if (
        this.isKeyword('PRIMARY') ||
        this.isKeyword('UNIQUE') ||
        this.isKeyword('CONSTRAINT') ||
        this.isKeyword('CHECK') ||
        this.isKeyword('FOREIGN')
      ) {
        throw new D1SyntaxError(
          'table-level constraints are not supported; declare PRIMARY KEY / UNIQUE on a column',
          this.peek().position,
        )
      }
      columns.push(this.parseColumn())
      if (this.matchPunct(',')) continue
      this.expectPunct(')')
      break
    }
    if (this.isKeyword('AS')) {
      throw new D1SyntaxError('CREATE TABLE ... AS SELECT is not supported', this.peek().position)
    }
    return {
      kind: 'create_table',
      table,
      ifNotExists,
      columns,
      paramCount: this.paramCount,
    }
  }

  private parseColumn(): ColumnSpec {
    const name = this.parseName()
    const typeTokens: string[] = []
    while (this.peek().type === 'ident') {
      typeTokens.push(this.next().value)
    }
    if (typeTokens.length === 0) {
      throw new D1SyntaxError(`column "${name}" needs an explicit SQL type`, this.peek().position)
    }
    let declaredType = typeTokens.join(' ')
    if (this.matchPunct('(')) {
      const parts: string[] = []
      for (;;) {
        const token = this.next()
        if (token.type !== 'number') {
          throw new D1SyntaxError('type sizes must be numbers', token.position)
        }
        parts.push(token.value)
        if (this.matchPunct(',')) continue
        this.expectPunct(')')
        break
      }
      declaredType += `(${parts.join(',')})`
    }

    const column: ColumnSpec = {
      name,
      declaredType,
      primaryKey: false,
      autoIncrement: false,
      notNull: false,
      unique: false,
    }

    for (;;) {
      if (this.matchKeyword('NOT')) {
        this.expectKeyword('NULL')
        column.notNull = true
        continue
      }
      if (this.matchKeyword('PRIMARY')) {
        this.expectKeyword('KEY')
        if (column.primaryKey) {
          throw new D1SyntaxError(`column "${name}" declares PRIMARY KEY twice`, this.peek().position)
        }
        column.primaryKey = true
        column.notNull = true
        if (this.isKeyword('ASC') || this.isKeyword('DESC')) this.next()
        if (this.matchKeyword('AUTOINCREMENT')) column.autoIncrement = true
        continue
      }
      if (this.matchKeyword('UNIQUE')) {
        column.unique = true
        continue
      }
      if (this.matchKeyword('DEFAULT')) {
        column.defaultExpr = this.parseDefaultExpr()
        continue
      }
      if (this.matchKeyword('REFERENCES')) {
        const table = this.parseName()
        let referencedColumn: string | undefined
        if (this.matchPunct('(')) {
          referencedColumn = this.parseName()
          this.expectPunct(')')
        }
        if (this.isKeyword('ON')) {
          throw new D1SyntaxError(
            'ON DELETE / ON UPDATE actions are not supported; foreign keys use RESTRICT',
            this.peek().position,
          )
        }
        column.references = {
          table,
          ...(referencedColumn ? { column: referencedColumn } : {}),
        }
        continue
      }
      if (this.isKeyword('CHECK') || this.isKeyword('COLLATE')) {
        throw new D1SyntaxError(
          `${this.peek().value} constraints are not supported by Larkflare D1`,
          this.peek().position,
        )
      }
      break
    }
    return column
  }

  private parseDefaultExpr(): SqlExpr {
    const negative = this.matchOp('-') ? -1 : this.matchOp('+') ? 1 : 0
    const token = this.next()
    let expr: SqlExpr
    if (token.type === 'number') {
      const value = Number(token.value)
      if (!Number.isFinite(value)) throw new D1SyntaxError('invalid numeric literal', token.position)
      expr = { type: 'literal', value: value * (negative || 1) }
    } else if (token.type === 'string') {
      if (negative !== 0) throw new D1SyntaxError('cannot apply a sign to a string default', token.position)
      expr = { type: 'literal', value: token.value }
    } else if (token.type === 'keyword' && token.value === 'NULL') {
      expr = { type: 'literal', value: null }
    } else if (token.type === 'keyword' && token.value === 'TRUE') {
      expr = { type: 'literal', value: true }
    } else if (token.type === 'keyword' && token.value === 'FALSE') {
      expr = { type: 'literal', value: false }
    } else if (token.type === 'punct' && token.value === '(') {
      expr = this.parseDefaultExpr()
      this.expectPunct(')')
    } else {
      throw new D1SyntaxError('DEFAULT accepts only literal values', token.position)
    }
    return expr
  }

  private parseDropTable(): DropTableStatement {
    this.expectKeyword('DROP')
    this.expectKeyword('TABLE')
    let ifExists = false
    if (this.matchKeyword('IF')) {
      this.expectKeyword('EXISTS')
      ifExists = true
    }
    return {
      kind: 'drop_table',
      table: this.parseName(),
      ifExists,
      paramCount: this.paramCount,
    }
  }

  private parseInsert(): InsertStatement {
    this.expectKeyword('INSERT')
    this.expectKeyword('INTO')
    const table = this.parseName()
    let columns: string[] | undefined
    if (this.matchPunct('(')) {
      columns = []
      for (;;) {
        columns.push(this.parseName())
        if (this.matchPunct(',')) continue
        this.expectPunct(')')
        break
      }
    }
    if (this.matchKeyword('DEFAULT')) {
      this.expectKeyword('VALUES')
      return { kind: 'insert', table, columns: columns ?? [], rows: [[]], paramCount: this.paramCount }
    }
    this.expectKeyword('VALUES')
    const rows: SqlExpr[][] = []
    for (;;) {
      this.expectPunct('(')
      const row: SqlExpr[] = []
      if (!this.isPunct(')')) {
        for (;;) {
          row.push(this.parseExpr())
          if (this.matchPunct(',')) continue
          break
        }
      }
      this.expectPunct(')')
      rows.push(row)
      if (this.matchPunct(',')) continue
      break
    }
    if (this.isKeyword('RETURNING')) {
      throw new D1SyntaxError('RETURNING is not supported', this.peek().position)
    }
    return { kind: 'insert', table, ...(columns ? { columns } : {}), rows, paramCount: this.paramCount }
  }

  private parseSelect(): SelectStatement {
    this.expectKeyword('SELECT')
    const distinct = this.matchKeyword('DISTINCT')
    const items: SelectItem[] = []
    for (;;) {
      if (this.matchOp('*')) {
        items.push({ kind: 'star' })
      } else {
        const expr = this.parseExpr()
        let alias: string | undefined
        if (this.matchKeyword('AS')) {
          alias = this.parseName()
        } else if (this.peek().type === 'ident') {
          alias = this.parseName()
        }
        items.push({ kind: 'expr', expr, ...(alias ? { alias } : {}) })
      }
      if (this.matchPunct(',')) continue
      break
    }

    let table: string | undefined
    let tableAlias: string | undefined
    const joins: JoinClause[] = []
    if (this.matchKeyword('FROM')) {
      const base = this.parseTableRef()
      table = base.table
      tableAlias = base.alias
      for (;;) {
        if (this.matchKeyword('JOIN')) {
          const joined = this.parseTableRef()
          joins.push({ type: 'inner', ...joined, on: this.parseJoinCondition() })
          continue
        }
        if (this.matchKeyword('INNER')) {
          this.expectKeyword('JOIN')
          const joined = this.parseTableRef()
          joins.push({ type: 'inner', ...joined, on: this.parseJoinCondition() })
          continue
        }
        if (this.matchKeyword('LEFT')) {
          this.matchKeyword('OUTER')
          this.expectKeyword('JOIN')
          const joined = this.parseTableRef()
          joins.push({ type: 'left', ...joined, on: this.parseJoinCondition() })
          continue
        }
        if (this.matchKeyword('CROSS')) {
          this.expectKeyword('JOIN')
          const joined = this.parseTableRef()
          joins.push({ type: 'cross', ...joined })
          continue
        }
        if (this.isKeyword('RIGHT') || this.isKeyword('FULL') || this.isKeyword('NATURAL')) {
          throw new D1SyntaxError(
            `${this.peek().value} JOIN is not supported; use INNER JOIN or LEFT JOIN`,
            this.peek().position,
          )
        }
        if (this.isPunct(',')) {
          throw new D1SyntaxError(
            'comma joins are not supported; use JOIN ... ON',
            this.peek().position,
          )
        }
        break
      }
    }

    let where: SqlExpr | undefined
    if (this.matchKeyword('WHERE')) where = this.parseExpr()

    const groupBy: SqlExpr[] = []
    if (this.matchKeyword('GROUP')) {
      this.expectKeyword('BY')
      for (;;) {
        groupBy.push(this.parseExpr())
        if (this.matchPunct(',')) continue
        break
      }
    }

    let having: SqlExpr | undefined
    if (this.matchKeyword('HAVING')) having = this.parseExpr()

    if (this.isKeyword('UNION')) {
      throw new D1SyntaxError('UNION is not supported by Larkflare D1', this.peek().position)
    }

    const orderBy: OrderItem[] = []
    if (this.matchKeyword('ORDER')) {
      this.expectKeyword('BY')
      for (;;) {
        const expr = this.parseExpr()
        let direction: 'ASC' | 'DESC' = 'ASC'
        if (this.matchKeyword('ASC')) direction = 'ASC'
        else if (this.matchKeyword('DESC')) direction = 'DESC'
        orderBy.push({ expr, direction })
        if (this.matchPunct(',')) continue
        break
      }
    }

    let limit: SqlExpr | undefined
    let offset: SqlExpr | undefined
    if (this.matchKeyword('LIMIT')) {
      limit = this.parseExpr()
      if (this.matchKeyword('OFFSET')) offset = this.parseExpr()
    }

    return {
      kind: 'select',
      distinct,
      items,
      ...(table ? { table } : {}),
      ...(tableAlias ? { alias: tableAlias } : {}),
      joins,
      ...(where ? { where } : {}),
      groupBy,
      ...(having ? { having } : {}),
      orderBy,
      ...(limit ? { limit } : {}),
      ...(offset ? { offset } : {}),
      paramCount: this.paramCount,
    }
  }

  private parseUpdate(): UpdateStatement {
    this.expectKeyword('UPDATE')
    const table = this.parseName()
    this.expectKeyword('SET')
    const assignments: Array<{ column: string; value: SqlExpr }> = []
    for (;;) {
      const column = this.parseName()
      this.expectOp('=')
      assignments.push({ column, value: this.parseExpr() })
      if (this.matchPunct(',')) continue
      break
    }
    let where: SqlExpr | undefined
    if (this.matchKeyword('WHERE')) where = this.parseExpr()
    if (this.isKeyword('RETURNING')) {
      throw new D1SyntaxError('RETURNING is not supported', this.peek().position)
    }
    return { kind: 'update', table, assignments, ...(where ? { where } : {}), paramCount: this.paramCount }
  }

  private parseDelete(): DeleteStatement {
    this.expectKeyword('DELETE')
    this.expectKeyword('FROM')
    const table = this.parseName()
    let where: SqlExpr | undefined
    if (this.matchKeyword('WHERE')) where = this.parseExpr()
    if (this.isKeyword('RETURNING')) {
      throw new D1SyntaxError('RETURNING is not supported', this.peek().position)
    }
    return { kind: 'delete', table, ...(where ? { where } : {}), paramCount: this.paramCount }
  }

  private parseExpr(): SqlExpr {
    return this.parseOr()
  }

  private parseOr(): SqlExpr {
    let left = this.parseAnd()
    while (this.matchKeyword('OR')) {
      left = { type: 'binary', op: 'OR', left, right: this.parseAnd() }
    }
    return left
  }

  private parseAnd(): SqlExpr {
    let left = this.parseNot()
    while (this.matchKeyword('AND')) {
      left = { type: 'binary', op: 'AND', left, right: this.parseNot() }
    }
    return left
  }

  private parseNot(): SqlExpr {
    if (this.matchKeyword('NOT')) {
      return { type: 'unary', op: 'NOT', operand: this.parseNot() }
    }
    return this.parseComparison()
  }

  private parseComparison(): SqlExpr {
    const left = this.parseAdditive()
    if (this.isOp('=') || this.isOp('!=') || this.isOp('<>') || this.isOp('>') || this.isOp('>=') || this.isOp('<') || this.isOp('<=')) {
      const token = this.next()
      return { type: 'binary', op: token.value === '<>' ? '!=' : token.value, left, right: this.parseAdditive() }
    }
    if (this.matchKeyword('IS')) {
      const not = this.matchKeyword('NOT')
      if (this.matchKeyword('NULL')) return { type: 'isNull', operand: left, not }
      throw new D1SyntaxError('IS only supports NULL', this.peek().position)
    }
    const negated = this.matchKeyword('NOT')
    if (this.matchKeyword('IN')) {
      this.expectPunct('(')
      const values: SqlExpr[] = []
      if (!this.isPunct(')')) {
        for (;;) {
          values.push(this.parseExpr())
          if (this.matchPunct(',')) continue
          break
        }
      }
      this.expectPunct(')')
      return { type: 'in', operand: left, values, not: negated }
    }
    if (this.matchKeyword('LIKE')) {
      return { type: 'like', operand: left, pattern: this.parseAdditive(), not: negated }
    }
    if (negated) {
      throw new D1SyntaxError('expected IN or LIKE after NOT', this.peek().position)
    }
    return left
  }

  private parseAdditive(): SqlExpr {
    let left = this.parseMultiplicative()
    while (true) {
      if (this.isOp('+') || this.isOp('-') || this.isOp('||')) {
        const op = this.next().value
        left = { type: 'binary', op, left, right: this.parseMultiplicative() }
        continue
      }
      break
    }
    return left
  }

  private parseMultiplicative(): SqlExpr {
    let left = this.parseUnary()
    while (true) {
      if (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
        const op = this.next().value
        left = { type: 'binary', op, left, right: this.parseUnary() }
        continue
      }
      break
    }
    return left
  }

  private parseUnary(): SqlExpr {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.next().value
      return { type: 'unary', op, operand: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): SqlExpr {
    const token = this.peek()
    if (token.type === 'number') {
      this.next()
      const value = Number(token.value)
      if (!Number.isFinite(value)) throw new D1SyntaxError('invalid numeric literal', token.position)
      return { type: 'literal', value }
    }
    if (token.type === 'string') {
      this.next()
      return { type: 'literal', value: token.value }
    }
    if (token.type === 'param') {
      this.next()
      const suffix = token.value.slice(1)
      const index = suffix ? Number(suffix) : this.paramCount + 1
      if (!Number.isInteger(index) || index < 1) {
        throw new D1SyntaxError(`invalid parameter ${token.value}`, token.position)
      }
      this.paramCount = Math.max(this.paramCount, index)
      return { type: 'param', index }
    }
    if (token.type === 'keyword') {
      if (token.value === 'NULL') {
        this.next()
        return { type: 'literal', value: null }
      }
      if (token.value === 'TRUE') {
        this.next()
        return { type: 'literal', value: true }
      }
      if (token.value === 'FALSE') {
        this.next()
        return { type: 'literal', value: false }
      }
      throw new D1SyntaxError(`unexpected keyword ${token.value}`, token.position)
    }
    if (token.type === 'punct' && token.value === '(') {
      this.next()
      const expr = this.parseExpr()
      this.expectPunct(')')
      return expr
    }
    if (token.type === 'ident') {
      const name = this.next().value
      if (this.matchPunct('(')) {
        if (this.matchOp('*')) {
          this.expectPunct(')')
          return { type: 'call', name, args: [], star: true }
        }
        const args: SqlExpr[] = []
        if (!this.isPunct(')')) {
          for (;;) {
            args.push(this.parseExpr())
            if (this.matchPunct(',')) continue
            break
          }
        }
        this.expectPunct(')')
        return { type: 'call', name, args }
      }
      if (this.matchPunct('.')) {
        const column = this.parseName()
        return { type: 'column', name: column, table: name }
      }
      return { type: 'column', name }
    }
    throw new D1SyntaxError(`unexpected token ${token.value || '<eof>'}`, token.position)
  }

  private parseTableRef(): { table: string; alias?: string } {
    const table = this.parseName()
    let alias: string | undefined
    if (this.matchKeyword('AS')) {
      alias = this.parseName()
    } else if (this.peek().type === 'ident') {
      alias = this.parseName()
    }
    return { table, ...(alias ? { alias } : {}) }
  }

  private parseJoinCondition(): SqlExpr {
    if (this.matchKeyword('ON')) return this.parseExpr()
    if (this.isKeyword('USING')) {
      throw new D1SyntaxError('USING is not supported; use ON', this.peek().position)
    }
    throw new D1SyntaxError('JOIN requires an ON condition', this.peek().position)
  }

  private parseName(): string {
    const token = this.peek()
    if (token.type !== 'ident') {
      throw new D1SyntaxError(
        `expected an identifier${token.value ? `, got ${token.value}` : ''}; quote reserved words with "double quotes"`,
        token.position,
      )
    }
    this.next()
    return token.value
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!
  }

  private next(): Token {
    const token = this.peek()
    if (token.type !== 'eof') this.index++
    return token
  }

  private isKeyword(word: string): boolean {
    const token = this.peek()
    return token.type === 'keyword' && token.value === word
  }

  private matchKeyword(word: string): boolean {
    if (!this.isKeyword(word)) return false
    this.index++
    return true
  }

  private expectKeyword(word: string): void {
    if (!this.matchKeyword(word)) {
      throw new D1SyntaxError(`expected ${word}`, this.peek().position)
    }
  }

  private isOp(op: string): boolean {
    const token = this.peek()
    return token.type === 'op' && token.value === op
  }

  private matchOp(op: string): boolean {
    if (!this.isOp(op)) return false
    this.index++
    return true
  }

  private expectOp(op: string): void {
    if (!this.matchOp(op)) throw new D1SyntaxError(`expected ${op}`, this.peek().position)
  }

  private isPunct(ch: string): boolean {
    const token = this.peek()
    return token.type === 'punct' && token.value === ch
  }

  private matchPunct(ch: string): boolean {
    if (!this.isPunct(ch)) return false
    this.index++
    return true
  }

  private expectPunct(ch: string): void {
    if (!this.matchPunct(ch)) throw new D1SyntaxError(`expected "${ch}"`, this.peek().position)
  }
}

/** Parse a script containing zero or more statements separated by `;`. */
export function parseStatements(sql: string): SqlStatement[] {
  const parser = new Parser(tokenize(sql))
  const statements: SqlStatement[] = []
  for (;;) {
    while (parser.matchSemicolon()) {}
    if (parser.atEnd()) break
    statements.push(parser.parseStatement())
    if (parser.atEnd()) break
    if (!parser.matchSemicolon()) {
      throw new D1SyntaxError('expected ";" between statements', 0)
    }
  }
  return statements
}

/** Parse exactly one statement. */
export function parseOne(sql: string): SqlStatement {
  const statements = parseStatements(sql)
  if (statements.length === 0) throw new D1SyntaxError('empty SQL statement', 0)
  if (statements.length > 1) {
    throw new D1SyntaxError('prepare() accepts exactly one statement; use exec() for scripts', 0)
  }
  return statements[0]!
}

export function containsAggregate(expr: SqlExpr): boolean {
  switch (expr.type) {
    case 'call':
      return isAggregateName(expr.name) || expr.args.some((arg) => containsAggregate(arg))
    case 'binary':
      return containsAggregate(expr.left) || containsAggregate(expr.right)
    case 'unary':
      return containsAggregate(expr.operand)
    case 'isNull':
      return containsAggregate(expr.operand)
    case 'in':
      return containsAggregate(expr.operand) || expr.values.some((value) => containsAggregate(value))
    case 'like':
      return containsAggregate(expr.operand) || containsAggregate(expr.pattern)
    default:
      return false
  }
}

export function statementHasAggregates(statement: SelectStatement): boolean {
  return statement.items.some((item) => item.kind === 'expr' && item.expr && containsAggregate(item.expr))
}

/** Canonical structural key, used for GROUP BY matching and alias resolution. */
export function expressionKey(expr: SqlExpr): string {
  switch (expr.type) {
    case 'literal':
      return `lit:${typeof expr.value}:${JSON.stringify(expr.value)}`
    case 'param':
      return `param:${expr.index}`
    case 'column':
      return `col:${expr.table ? normalizeIdentifier(expr.table) : ''}.${normalizeIdentifier(expr.name)}`
    case 'binary':
      return `bin:${expr.op}:${expressionKey(expr.left)}:${expressionKey(expr.right)}`
    case 'unary':
      return `un:${expr.op}:${expressionKey(expr.operand)}`
    case 'isNull':
      return `null:${expr.not ? 1 : 0}:${expressionKey(expr.operand)}`
    case 'in':
      return `in:${expr.not ? 1 : 0}:${expressionKey(expr.operand)}:${expr.values
        .map(expressionKey)
        .join(',')}`
    case 'like':
      return `like:${expr.not ? 1 : 0}:${expressionKey(expr.operand)}:${expressionKey(expr.pattern)}`
    case 'call':
      return `call:${normalizeIdentifier(expr.name)}:${expr.star ? '*' : expr.args.map(expressionKey).join(',')}`
  }
}

export function walkExpr(expr: SqlExpr, visit: (expr: SqlExpr) => void): void {
  visit(expr)
  switch (expr.type) {
    case 'binary':
      walkExpr(expr.left, visit)
      walkExpr(expr.right, visit)
      break
    case 'unary':
      walkExpr(expr.operand, visit)
      break
    case 'isNull':
      walkExpr(expr.operand, visit)
      break
    case 'in':
      walkExpr(expr.operand, visit)
      for (const value of expr.values) walkExpr(value, visit)
      break
    case 'like':
      walkExpr(expr.operand, visit)
      walkExpr(expr.pattern, visit)
      break
    case 'call':
      for (const arg of expr.args) walkExpr(arg, visit)
      break
    default:
      break
  }
}

export function renderCreateTable(table: string, columns: ColumnSpec[]): string {
  const rendered = columns.map((column) => {
    let text = `${quoteIdentifier(column.name)} ${column.declaredType}`
    if (column.primaryKey) text += ' PRIMARY KEY'
    if (column.autoIncrement) text += ' AUTOINCREMENT'
    if (column.notNull && !column.primaryKey) text += ' NOT NULL'
    if (column.unique && !column.primaryKey) text += ' UNIQUE'
    if (column.defaultExpr) text += ` DEFAULT ${renderLiteral(column.defaultExpr)}`
    if (column.references) {
      text += ` REFERENCES ${quoteIdentifier(column.references.table)}`
      if (column.references.column) text += `(${quoteIdentifier(column.references.column)})`
    }
    return text
  })
  return `CREATE TABLE ${quoteIdentifier(table)} (${rendered.join(', ')})`
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function renderLiteral(expr: SqlExpr): string {
  if (expr.type === 'literal') {
    if (expr.value === null) return 'NULL'
    if (typeof expr.value === 'string') return `'${expr.value.replaceAll("'", "''")}'`
    if (typeof expr.value === 'boolean') return expr.value ? 'TRUE' : 'FALSE'
    return String(expr.value)
  }
  if (expr.type === 'unary' && (expr.op === '-' || expr.op === '+') && expr.operand.type === 'literal') {
    return `${expr.op}${renderLiteral(expr.operand)}`
  }
  throw new D1SyntaxError('DEFAULT accepts only literal values', 0)
}
