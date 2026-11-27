import type { LarkflareConfig, SchemaDefinition } from '@larkflare/db'
import type { D1ColumnType, SqlExpr } from './sql.js'

export type { D1ColumnType } from './sql.js'

/** Declarative column definition persisted in the D1 schema catalog. */
export interface D1Column {
  name: string
  type: D1ColumnType
  declaredType: string
  primaryKey: boolean
  autoIncrement: boolean
  notNull: boolean
  unique: boolean
  /** Default expression, restricted to literals at CREATE TABLE time. */
  defaultExpr?: SqlExpr
  /** RESTRICT-style foreign key; the referenced column is resolved at CREATE. */
  references?: { table: string; column?: string }
}

/** Declarative definition of one SQL table. */
export interface D1TableDefinition {
  name: string
  columns: D1Column[]
  /** Canonical CREATE TABLE statement, reused by `dump()`. */
  sql: string
  /** Name of the INTEGER PRIMARY KEY column that aliases the rowid, if any. */
  rowIdColumn?: string
  createdAt: number
}

/** Result metadata, shaped like Cloudflare D1's `D1Meta`. */
export interface D1Meta {
  /** Statement wall time in milliseconds. */
  duration: number
  /** Rows inserted, updated or deleted. */
  changes: number
  /** Rowid allocated by the last INSERT, or 0. */
  last_row_id: number
  /** Whether this statement may have changed persisted data. */
  changed_db: boolean
  /** Rows read while answering the statement. */
  rows_read: number
  /** Rows written by the statement. */
  rows_written: number
}

/** A result row. D1 returns plain objects keyed by column name. */
export type D1Row = Record<string, unknown>

/** Result of `all()`, `run()` and `batch()`. */
export interface D1Result<T = D1Row> {
  success: true
  results: T[]
  meta: D1Meta
}

/** Result of `exec()`. */
export interface D1ExecResult {
  count: number
  duration: number
}

/** Options for `raw()`. */
export interface D1RawOptions {
  /** Include the column names as the first row. Defaults to false. */
  columnNames?: boolean
}

/** Public description of a table, returned by `listTables()`. */
export interface D1TableInfo {
  name: string
  columns: Array<Pick<D1Column, 'name' | 'type' | 'primaryKey' | 'notNull' | 'unique'>>
  rowCount: number
}

/** Options accepted by {@link D1}. */
export interface D1Options extends LarkflareConfig {
  /** Reuse an existing Larkflare DB client instead of creating one. */
  client?: import('@larkflare/db').Larkflare
  /** Rows fetched per Bitable page while scanning. Defaults to 500. */
  pageSize?: number
}

/** @internal DB schema used for a D1 table. */
export type D1DbSchema = SchemaDefinition
