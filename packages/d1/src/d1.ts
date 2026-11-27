import {
  createClient,
  type DatabaseInfo,
  type Larkflare,
  type LarkflareConfig,
} from '@larkflare/db'
import { D1Database } from './database.js'
import type { D1Options } from './types.js'

/**
 * Entry point for Larkflare D1.
 *
 * A D1 instance is a thin, relational view over Larkflare DB databases:
 * each logical database is one Bitable Base, and each SQL table is one DB
 * table inside it.
 *
 * @example
 * ```ts
 * const d1 = createD1({ appId, appSecret })
 * const db = d1.database('app')
 * await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
 * await db.prepare('INSERT INTO users (name) VALUES (?)').bind('Ada').run()
 * const ada = await db.prepare('SELECT * FROM users WHERE name = ?').bind('Ada').first()
 * ```
 */
export class D1 {
  readonly client: Larkflare
  private readonly ownsClient: boolean
  private readonly pageSize?: number
  private readonly databases = new Map<string, D1Database>()

  constructor(options: D1Options) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('D1 requires a configuration object')
    }
    const { client, pageSize, ...config } = options
    this.ownsClient = client === undefined
    this.client = client ?? createClient(config as LarkflareConfig)
    this.pageSize = pageSize
  }

  /** Get a lazy database handle. The Bitable Base is created on first use. */
  useDatabase(name: string): D1Database {
    let database = this.databases.get(name)
    if (!database) {
      database = new D1Database(
        this.client.useDatabase(name),
        this.pageSize !== undefined ? { pageSize: this.pageSize } : {},
      )
      this.databases.set(name, database)
    }
    return database
  }

  /** Alias for {@link useDatabase}. */
  database(name: string): D1Database {
    return this.useDatabase(name)
  }

  /** List logical databases visible in the shared Larkflare DB catalog. */
  listDatabases(): Promise<DatabaseInfo[]> {
    return this.client.listDatabases()
  }

  /**
   * Flush pending writes and close the underlying DB client. A client
   * supplied through `options.client` is left open for its owner to close.
   */
  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close()
  }
}

export function createD1(options: D1Options): D1 {
  return new D1(options)
}
