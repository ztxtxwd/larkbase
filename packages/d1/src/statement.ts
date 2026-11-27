import type { D1Database, InternalExecution } from './database.js'
import type { SqlStatement } from './sql.js'
import type { D1RawOptions, D1Result, D1Row } from './types.js'

/**
 * A prepared SQL statement, shaped like Cloudflare D1's
 * `D1PreparedStatement`.
 *
 * `bind()` returns a new statement rather than mutating this one, so a
 * prepared statement can be reused with different parameters.
 */
export class D1PreparedStatement {
  readonly database: D1Database
  #statement: SqlStatement
  #params: unknown[]

  constructor(database: D1Database, statement: SqlStatement, params: unknown[] = []) {
    this.database = database
    this.#statement = statement
    this.#params = params
  }

  /** Bind positional `?` parameters. */
  bind(...values: unknown[]): D1PreparedStatement {
    return new D1PreparedStatement(this.database, this.#statement, values)
  }

  /** Execute and return every row. */
  async all<T = D1Row>(): Promise<D1Result<T>> {
    return (await this.executeInternal()).result as D1Result<T>
  }

  /** Execute and return the first row (or one column of it), or `null`. */
  async first<T = unknown>(columnName?: string): Promise<T | null> {
    const { result } = await this.executeInternal()
    const row = result.results[0]
    if (!row) return null
    if (columnName === undefined) return row as T
    return (row[columnName] ?? null) as T | null
  }

  /** Execute the statement. */
  async run<T = D1Row>(): Promise<D1Result<T>> {
    return this.all<T>()
  }

  /**
   * Execute and return rows as positional arrays. Pass
   * `{ columnNames: true }` to prepend the column-name row.
   */
  async raw<T = unknown[]>(options: D1RawOptions = {}): Promise<T[]> {
    const { columns, raw } = await this.executeInternal()
    const rows: unknown[][] = raw.map((row) => [...row])
    if (options.columnNames) rows.unshift([...columns])
    return rows as T[]
  }

  /** @internal */
  async executeInternal(): Promise<InternalExecution> {
    return this.database.execute(this.#statement, this.#params)
  }
}
