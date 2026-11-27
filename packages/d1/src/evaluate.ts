import { D1Error } from './errors.js'
import { isAggregateName, normalizeIdentifier, type SqlExpr, type SqlLiteral } from './sql.js'
import type { D1Column } from './types.js'

export interface EvalContext {
  params: unknown[]
  /** Maps lower-cased column names to their declared spelling. */
  columns?: Map<string, string>
  row?: Record<string, unknown>
}

export function evaluate(expr: SqlExpr, ctx: EvalContext): unknown {
  switch (expr.type) {
    case 'literal':
      return expr.value
    case 'param': {
      const value = ctx.params[expr.index - 1]
      return value === undefined ? null : value
    }
    case 'column': {
      if (!ctx.row) throw new D1Error(`column "${expr.name}" cannot be used in this context`)
      const lookup = expr.table
        ? `${normalizeIdentifier(expr.table)}\u0001${normalizeIdentifier(expr.name)}`
        : normalizeIdentifier(expr.name)
      const declared = ctx.columns?.get(lookup)
      if (!declared) {
        throw new D1Error(
          expr.table ? `no such column: ${expr.table}.${expr.name}` : `no such column: ${expr.name}`,
        )
      }
      return ctx.row[declared] ?? null
    }
    case 'unary': {
      const value = evaluate(expr.operand, ctx)
      if (expr.op === 'NOT') {
        const truth = sqlTruth(value)
        return truth === null ? null : !truth
      }
      const number = toNumber(value)
      if (number === null) return null
      return expr.op === '-' ? -number : number
    }
    case 'binary':
      return evaluateBinary(expr.op, expr.left, expr.right, ctx)
    case 'isNull': {
      const value = evaluate(expr.operand, ctx)
      return expr.not ? value !== null : value === null
    }
    case 'in': {
      const value = evaluate(expr.operand, ctx)
      if (value === null) return null
      let found = false
      let sawNull = false
      for (const item of expr.values) {
        const candidate = evaluate(item, ctx)
        if (candidate === null) {
          sawNull = true
          continue
        }
        if (sqlEquals(value, candidate)) {
          found = true
          break
        }
      }
      if (found) return !expr.not
      if (sawNull) return null
      return expr.not
    }
    case 'like': {
      const value = evaluate(expr.operand, ctx)
      const pattern = evaluate(expr.pattern, ctx)
      if (value === null || pattern === null) return null
      const matched = sqlLike(String(value), String(pattern))
      return expr.not ? !matched : matched
    }
    case 'call': {
      if (isAggregateName(expr.name)) {
        throw new D1Error(`aggregate function ${expr.name}() is only allowed in the SELECT list`)
      }
      throw new D1Error(`unknown function: ${expr.name}`)
    }
  }
}

function evaluateBinary(
  op: string,
  leftExpr: SqlExpr,
  rightExpr: SqlExpr,
  ctx: EvalContext,
): unknown {
  if (op === 'AND') {
    const left = sqlTruth(evaluate(leftExpr, ctx))
    if (left === false) return false
    const right = sqlTruth(evaluate(rightExpr, ctx))
    if (right === false) return false
    if (left === null || right === null) return null
    return true
  }
  if (op === 'OR') {
    const left = sqlTruth(evaluate(leftExpr, ctx))
    if (left === true) return true
    const right = sqlTruth(evaluate(rightExpr, ctx))
    if (right === true) return true
    if (left === null || right === null) return null
    return false
  }

  const left = evaluate(leftExpr, ctx)
  const right = evaluate(rightExpr, ctx)
  if (sexprNull(left) || sexprNull(right)) return null

  switch (op) {
    case '=':
      return sqlEquals(left, right)
    case '!=':
      return !sqlEquals(left, right)
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const cmp = sqlCompare(left, right)
      if (cmp === null) return null
      if (op === '<') return cmp < 0
      if (op === '<=') return cmp <= 0
      if (op === '>') return cmp > 0
      return cmp >= 0
    }
    case '+':
    case '-':
    case '*':
    case '/':
    case '%': {
      const a = toNumber(left)
      const b = toNumber(right)
      if (a === null || b === null) return null
      if (op === '+') return a + b
      if (op === '-') return a - b
      if (op === '*') return a * b
      if (op === '/') return b === 0 ? null : a / b
      return b === 0 ? null : a % b
    }
    case '||':
      return sqlText(left) + sqlText(right)
    default:
      throw new D1Error(`unsupported operator ${op}`)
  }
}

function sexprNull(value: unknown): boolean {
  return value === null || value === undefined
}

/** SQLite-style truthiness: NULL stays unknown, 0 / '' / 'abc' are falsy. */
export function sqlTruth(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : false
  if (typeof value === 'string') {
    const number = Number(value)
    return Number.isFinite(number) ? number !== 0 : false
  }
  if (value instanceof Uint8Array) return value.byteLength > 0
  return true
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return 0
    const number = Number(trimmed)
    return Number.isFinite(number) ? number : null
  }
  return null
}

export function sqlText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8')
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function typeRank(value: unknown): number {
  if (typeof value === 'boolean' || typeof value === 'number') return 1
  if (typeof value === 'string') return 2
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return 3
  return 4
}

function asComparable(value: unknown): number | string | Uint8Array | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' || typeof value === 'string') return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Uint8Array) return value
  return null
}

export function sqlEquals(left: unknown, right: unknown): boolean {
  if (sexprNull(left) || sexprNull(right)) return false
  const a = asComparable(left)
  const b = asComparable(right)
  if (a === null || b === null) {
    try {
      return JSON.stringify(left) === JSON.stringify(right)
    } catch {
      return false
    }
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (typeof a === 'string' && typeof b === 'string') return a === b
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.byteLength !== b.byteLength) return false
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
    return true
  }
  return false
}

/** Compare two SQL values. NULL is caller-handled; mixed types compare by rank. */
export function sqlCompare(left: unknown, right: unknown): number | null {
  if (sexprNull(left) || sexprNull(right)) return null
  const a = asComparable(left)
  const b = asComparable(right)
  if (a === null || b === null) {
    const sa = JSON.stringify(left)
    const sb = JSON.stringify(right)
    return sa === sb ? 0 : sa < sb ? -1 : 1
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : a < b ? -1 : 1
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const length = Math.min(a.byteLength, b.byteLength)
    for (let i = 0; i < length; i++) {
      if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1
    }
    return a.byteLength === b.byteLength ? 0 : a.byteLength < b.byteLength ? -1 : 1
  }
  const rankA = typeRank(left)
  const rankB = typeRank(right)
  if (rankA !== rankB) return rankA < rankB ? -1 : 1
  return 0
}

/** SQL LIKE: `%` and `_`, case-insensitive like SQLite's default. */
export function sqlLike(value: string, pattern: string): boolean {
  let source = '^'
  for (const ch of pattern) {
    if (ch === '%') source += '.*'
    else if (ch === '_') source += '.'
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  source += '$'
  return new RegExp(source, 'i').test(value)
}

/** Evaluate an expression that must not reference a row (LIMIT/OFFSET/DEFAULT). */
export function evaluateConstant(expr: SqlExpr, params: unknown[]): unknown {
  return evaluate(expr, { params })
}

export function literalValue(expr: SqlExpr | undefined): SqlLiteral | undefined {
  if (!expr) return undefined
  if (expr.type === 'literal') return expr.value
  if (expr.type === 'unary' && (expr.op === '-' || expr.op === '+') && expr.operand.type === 'literal') {
    if (typeof expr.operand.value !== 'number') {
      throw new D1Error('DEFAULT only accepts numeric signs')
    }
    return expr.op === '-' ? -expr.operand.value : expr.operand.value
  }
  throw new D1Error('DEFAULT accepts only literal values')
}

/** Coerce a bound value into the storage type declared by a column. */
export function coerceForColumn(value: unknown, column: D1Column, rowid = false): unknown {
  if (value === undefined) value = null
  if (value === null) {
    if (!column.notNull && !rowid) return null
    throw new D1Error(`NOT NULL constraint failed: ${column.name}`)
  }

  switch (column.type) {
    case 'INTEGER': {
      const number = typeof value === 'boolean' ? (value ? 1 : 0) : toNumber(value)
      if (number === null || !Number.isInteger(number) || !Number.isSafeInteger(number)) {
        throw new D1Error(`column "${column.name}" expects an INTEGER`)
      }
      return number
    }
    case 'REAL':
    case 'NUMERIC': {
      const number = toNumber(value)
      if (number === null) throw new D1Error(`column "${column.name}" expects a number`)
      return number
    }
    case 'BOOLEAN': {
      if (typeof value === 'boolean') return value
      if (value === 0 || value === 1) return value === 1
      if (typeof value === 'string') {
        const lower = value.toLowerCase()
        if (lower === 'true' || lower === '1') return true
        if (lower === 'false' || lower === '0') return false
      }
      throw new D1Error(`column "${column.name}" expects a BOOLEAN`)
    }
    case 'TEXT': {
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      throw new D1Error(`column "${column.name}" expects TEXT`)
    }
    case 'BLOB': {
      if (Buffer.isBuffer(value)) return value
      if (value instanceof ArrayBuffer) return Buffer.from(value)
      if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      if (typeof value === 'string') return Buffer.from(value, 'utf8')
      throw new D1Error(`column "${column.name}" expects a BLOB (ArrayBuffer, Uint8Array or string)`)
    }
    case 'JSON':
      return value
  }
}

/** Normalise a value read from DB into the shape D1 exposes. */
export async function readValue(value: unknown, column: D1Column): Promise<unknown> {
  if (value === null || value === undefined) return null
  switch (column.type) {
    case 'INTEGER':
    case 'REAL':
    case 'NUMERIC':
      return typeof value === 'number' ? value : Number(value)
    case 'BOOLEAN':
      return value === true || value === 1 || value === 'true'
    case 'TEXT':
      return typeof value === 'string' ? value : String(value)
    case 'JSON':
      return value
    case 'BLOB': {
      if (value instanceof ArrayBuffer) return value
      if (value instanceof Uint8Array) return toArrayBuffer(value)
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { bytes?: unknown }).bytes === 'function'
      ) {
        const bytes = await (value as { bytes: () => Promise<Buffer> }).bytes()
        return toArrayBuffer(bytes)
      }
      throw new D1Error(`column "${column.name}" did not contain BLOB data`)
    }
  }
}

export function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/** Render a value as a SQL literal for `dump()`. */
export function renderSqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new D1Error('cannot dump a non-finite number')
    return String(value)
  }
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  if (value instanceof ArrayBuffer) return renderBlob(new Uint8Array(value))
  if (value instanceof Uint8Array) return renderBlob(value)
  return `'${JSON.stringify(value).replaceAll("'", "''")}'`
}

function renderBlob(bytes: Uint8Array): string {
  return `X'${Buffer.from(bytes).toString('hex')}'`
}
