import {
  LarkflareError,
  ValidationError,
  type Document,
  type Larkflare,
  type Table,
} from '@larkflare/db'
import type { ReadableStream } from 'node:stream/web'
import { decodeCursor, encodeCursor, stripeIndex, validateKey } from './keys.js'
import {
  KV_ENTRIES_SCHEMA,
  KV_ENTRIES_TABLE,
  type KVGetOptions,
  type KVGetWithMetadataResult,
  type KVListKey,
  type KVListOptions,
  type KVListResult,
  type KVPutOptions,
  type KVValue,
  type KVValueType,
} from './types.js'
import {
  normalizeValue,
  resolveExpiration,
  storedValueBytes,
  toArrayBuffer,
  toReadableStream,
  validateMetadata,
} from './value.js'

const DEFAULT_LIST_LIMIT = 1000
const MAX_LIST_LIMIT = 1000
const WRITE_STRIPES = 64

const KNOWN_VALUE_TYPES = new Set<KVValueType>(['text', 'json', 'arrayBuffer', 'stream'])

/** Serialises asynchronous work on one queue. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }
}

function isDuplicateIdError(error: unknown): boolean {
  return error instanceof ValidationError && /Duplicate _id/.test(error.message)
}

function isExpired(row: Document, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const expiration = row.expiration
  return typeof expiration === 'number' && Number.isFinite(expiration) && nowSeconds >= expiration
}

function resolveGetType(input?: KVValueType | KVGetOptions): KVValueType {
  if (input === undefined || input === null) return 'text'
  if (typeof input === 'string') {
    if (!KNOWN_VALUE_TYPES.has(input)) {
      throw new ValidationError(`Unsupported value type "${input}"`)
    }
    return input
  }
  if (typeof input !== 'object') {
    throw new ValidationError('get options must be a string type or an options object')
  }
  const type = input.type ?? 'text'
  if (!KNOWN_VALUE_TYPES.has(type)) {
    throw new ValidationError(`Unsupported value type "${String(type)}"`)
  }
  return type
}

function viewValue(bytes: Buffer, type: KVValueType): unknown {
  switch (type) {
    case 'text':
      return bytes.toString('utf8')
    case 'json':
      return JSON.parse(bytes.toString('utf8'))
    case 'arrayBuffer':
      return toArrayBuffer(bytes)
    case 'stream':
      return toReadableStream(bytes)
  }
}

/**
 * One Workers KV namespace, backed by a Larkflare database named
 * `kv:<namespace>` whose `entries` table holds one row per key.
 */
export class KVNamespace {
  readonly name: string

  private readonly client: Larkflare
  private readonly listScanLimit: number
  private readonly writeStripes = Array.from({ length: WRITE_STRIPES }, () => new Mutex())

  private tableInstance?: Table
  private ensurePromise?: Promise<void>

  constructor(name: string, client: Larkflare, listScanLimit: number) {
    this.name = name
    this.client = client
    this.listScanLimit = listScanLimit
  }

  /** Lazily create or adopt the namespace Base and its `entries` table. */
  ensure(): Promise<void> {
    if (!this.ensurePromise) {
      this.ensurePromise = this.runEnsure().catch((error) => {
        this.ensurePromise = undefined
        throw error
      })
    }
    return this.ensurePromise
  }

  private async runEnsure(): Promise<void> {
    const database = this.client.useDatabase(`kv:${this.name}`)
    const table = database.defineTable(KV_ENTRIES_TABLE, KV_ENTRIES_SCHEMA)
    await table.ensure()
    this.tableInstance = table
  }

  private async entries(): Promise<Table> {
    await this.ensure()
    if (!this.tableInstance) throw new LarkflareError('KV entries table is not initialised')
    return this.tableInstance
  }

  /**
   * Look up a row by key. `Table.get()` also accepts raw Bitable record ids
   * (`rec...`); a missing key that looks like one must not alias another row.
   */
  private async findEntry(table: Table, key: string): Promise<Document | null> {
    const row = await table.get(key)
    return row && row._id === key ? row : null
  }

  async put(key: string, value: KVValue, options: KVPutOptions = {}): Promise<void> {
    validateKey(key)
    const encoded = await normalizeValue(value)
    const metadata = validateMetadata(options.metadata)
    const expiration = resolveExpiration(options)
    const fields = {
      encoding: encoded.encoding,
      value: encoded.value,
      data: encoded.data,
      metadata,
      expiration,
    }

    // In-process only: serialise find-then-write for this key so concurrent
    // puts cannot both insert a new row. Bitable has no unique constraint.
    const stripe = this.writeStripes[stripeIndex(key, this.writeStripes.length)]!
    await stripe.runExclusive(async () => {
      const table = await this.entries()
      const existing = await this.findEntry(table, key)
      if (existing) {
        await table.updateOne({ _id: key }, fields)
        return
      }
      try {
        await table.insertOne({ _id: key, ...fields })
      } catch (error) {
        if (!isDuplicateIdError(error)) throw error
        await table.updateOne({ _id: key }, fields)
      }
    })
  }

  async delete(key: string): Promise<void> {
    validateKey(key)
    const table = await this.entries()
    await table.deleteOne({ _id: key })
  }

  get(key: string): Promise<string | null>
  get(key: string, type: 'text'): Promise<string | null>
  get<ExpectedValue = unknown>(key: string, type: 'json'): Promise<ExpectedValue | null>
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
  get(key: string, type: 'stream'): Promise<ReadableStream | null>
  get(key: string, options: KVGetOptions<'text'>): Promise<string | null>
  get<ExpectedValue = unknown>(
    key: string,
    options: KVGetOptions<'json'>,
  ): Promise<ExpectedValue | null>
  get(key: string, options: KVGetOptions<'arrayBuffer'>): Promise<ArrayBuffer | null>
  get(key: string, options: KVGetOptions<'stream'>): Promise<ReadableStream | null>
  async get(key: string, typeOrOptions?: KVValueType | KVGetOptions): Promise<any> {
    const type = resolveGetType(typeOrOptions)
    validateKey(key)
    const table = await this.entries()
    const row = await this.findEntry(table, key)
    if (!row || isExpired(row)) return null
    return viewValue(await storedValueBytes(row), type)
  }

  getWithMetadata<Metadata = unknown>(
    key: string,
  ): Promise<KVGetWithMetadataResult<string, Metadata>>
  getWithMetadata<Metadata = unknown>(
    key: string,
    type: 'text',
  ): Promise<KVGetWithMetadataResult<string, Metadata>>
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: string,
    type: 'json',
  ): Promise<KVGetWithMetadataResult<ExpectedValue, Metadata>>
  getWithMetadata<Metadata = unknown>(
    key: string,
    type: 'arrayBuffer',
  ): Promise<KVGetWithMetadataResult<ArrayBuffer, Metadata>>
  getWithMetadata<Metadata = unknown>(
    key: string,
    type: 'stream',
  ): Promise<KVGetWithMetadataResult<ReadableStream, Metadata>>
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: KVGetOptions<'text'>,
  ): Promise<KVGetWithMetadataResult<string, Metadata>>
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: string,
    options: KVGetOptions<'json'>,
  ): Promise<KVGetWithMetadataResult<ExpectedValue, Metadata>>
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: KVGetOptions<'arrayBuffer'>,
  ): Promise<KVGetWithMetadataResult<ArrayBuffer, Metadata>>
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: KVGetOptions<'stream'>,
  ): Promise<KVGetWithMetadataResult<ReadableStream, Metadata>>
  async getWithMetadata(key: string, typeOrOptions?: KVValueType | KVGetOptions): Promise<any> {
    const type = resolveGetType(typeOrOptions)
    validateKey(key)
    const table = await this.entries()
    const row = await this.findEntry(table, key)
    if (!row || isExpired(row)) return { value: null, metadata: null }
    const value = viewValue(await storedValueBytes(row), type)
    return { value, metadata: row.metadata === undefined ? null : row.metadata }
  }

  async list<Metadata = unknown>(options: KVListOptions = {}): Promise<KVListResult<Metadata>> {
    const prefix = options.prefix ?? ''
    if (typeof prefix !== 'string') {
      throw new ValidationError('prefix must be a string or null')
    }
    const after =
      options.cursor === undefined || options.cursor === null ? undefined : decodeCursor(options.cursor)
    if (options.limit !== undefined && !Number.isFinite(options.limit)) {
      throw new ValidationError('limit must be a finite number')
    }
    const limit = Math.min(
      MAX_LIST_LIMIT,
      Math.max(1, Math.floor(options.limit ?? DEFAULT_LIST_LIMIT)),
    )

    const table = await this.entries()
    // Bitable has no key index: listing necessarily scans the namespace.
    const rows = await table
      .find({}, {
        limit: this.listScanLimit + 1,
        fields: ['encoding', 'expiration', 'metadata'],
      })
      .toArray()
    if (rows.length > this.listScanLimit) {
      throw new LarkflareError(
        `Namespace "${this.name}" has more than ${this.listScanLimit} keys. ` +
          `list scans the whole namespace; raise listScanLimit to scan further.`,
        { code: 'ListScanLimitExceeded' },
      )
    }

    const now = Math.floor(Date.now() / 1000)
    const eligible: Array<{ name: string; expiration?: number; metadata?: unknown }> = []
    for (const row of rows) {
      const key = row._id
      if (typeof key !== 'string') continue
      if (!key.startsWith(prefix)) continue
      if (after !== undefined && key <= after) continue
      if (isExpired(row, now)) continue
      eligible.push({
        name: key,
        expiration: typeof row.expiration === 'number' ? row.expiration : undefined,
        metadata: row.metadata,
      })
    }
    eligible.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )

    const page = eligible.slice(0, limit)
    const keys: Array<KVListKey<Metadata>> = page.map((entry) => {
      const key: KVListKey<Metadata> = { name: entry.name }
      if (typeof entry.expiration === 'number' && Number.isFinite(entry.expiration)) {
        key.expiration = entry.expiration
      }
      if (entry.metadata !== null && entry.metadata !== undefined) {
        key.metadata = entry.metadata as Metadata
      }
      return key
    })

    if (eligible.length <= limit) {
      return { keys, list_complete: true }
    }
    return {
      keys,
      list_complete: false,
      cursor: encodeCursor(page[page.length - 1]!.name),
    }
  }
}
