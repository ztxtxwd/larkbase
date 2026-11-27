import { createClient, ValidationError, type Larkflare, type LarkflareConfig } from '@larkflare/db'
import { isValidNamespaceName, validateNamespaceName } from './keys.js'
import { KVNamespace } from './namespace.js'
import type { KVNamespaceInfo } from './types.js'

const NAMESPACE_PREFIX = 'kv:'
const DEFAULT_LIST_SCAN_LIMIT = 100_000

export interface KVOptions extends LarkflareConfig {
  client?: Larkflare
  /** Max rows list() scans per call. Defaults to 100000. */
  listScanLimit?: number
}

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive finite number`)
  }
  return Math.max(1, Math.floor(value))
}

/**
 * Workers KV-style key-value storage over Feishu/Lark Bitable.
 *
 * Each namespace is a Larkflare database named `kv:<namespace>`; each key is a
 * row in its `entries` table.
 */
export class KV {
  readonly client: Larkflare

  private readonly namespaces = new Map<string, KVNamespace>()
  private readonly listScanLimit: number
  private readonly ownsClient: boolean

  constructor(options: KVOptions) {
    this.client = options.client ?? createClient(options)
    this.ownsClient = options.client === undefined
    this.listScanLimit = positiveInteger(
      options.listScanLimit,
      'listScanLimit',
      DEFAULT_LIST_SCAN_LIMIT,
    )
  }

  /** Get a lazy namespace handle. The backing Base is created on first operation. */
  namespace(name: string): KVNamespace {
    validateNamespaceName(name)
    let namespace = this.namespaces.get(name)
    if (!namespace) {
      namespace = new KVNamespace(name, this.client, this.listScanLimit)
      this.namespaces.set(name, namespace)
    }
    return namespace
  }

  /** Alias for {@link KV.namespace}. */
  useNamespace(name: string): KVNamespace {
    return this.namespace(name)
  }

  /** Eagerly create (or adopt) a namespace and return its handle. */
  async createNamespace(name: string): Promise<KVNamespace> {
    const namespace = this.namespace(name)
    await namespace.ensure()
    return namespace
  }

  /** Discover namespaces by the `kv:` database-name prefix. */
  async listNamespaces(): Promise<KVNamespaceInfo[]> {
    const databases = await this.client.listDatabases()
    const namespaces: KVNamespaceInfo[] = []
    for (const database of databases) {
      if (!database.name.startsWith(NAMESPACE_PREFIX)) continue
      const name = database.name.slice(NAMESPACE_PREFIX.length)
      if (!isValidNamespaceName(name)) continue
      namespaces.push({ name, baseToken: database.token })
    }
    return namespaces
  }

  /** Close the underlying client, but only when this instance created it. */
  async close(): Promise<void> {
    if (!this.ownsClient) return
    await this.client.close()
  }
}

export function createKV(options: KVOptions): KV {
  return new KV(options)
}
