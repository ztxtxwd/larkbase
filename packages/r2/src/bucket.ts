import { createHash } from 'node:crypto'
import {
  LarkflareError,
  NotFoundError,
  ValidationError,
  type Document,
  type Larkflare,
  type Table,
} from '@larkflare/db'
import { readBody } from './body.js'
import { decodeCursor, encodeCursor, validateKey } from './keys.js'
import type { Mutex } from './mutex.js'
import type { PublicUrlPool } from './public-url-pool.js'
import {
  R2_OBJECTS_SCHEMA,
  R2_OBJECTS_TABLE,
  type ListObjectsOptions,
  type PutObjectOptions,
  type R2Body,
  type R2HeadObjectResult,
  type R2ListObjectsResult,
  type R2Object,
  type R2ObjectMetadata,
} from './types.js'

export interface R2BucketContext {
  name: string
  client: Larkflare
  uploadMutex: Mutex
  publicUrls: PublicUrlPool
  listScanLimit: number
}

const DEFAULT_LIST_LIMIT = 1000
const MAX_LIST_LIMIT = 1000
const MAX_FILE_NAME_LENGTH = 200

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml; charset=utf-8',
  avif: 'image/avif',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  ndjson: 'application/x-ndjson; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  wasm: 'application/wasm',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
}

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'application/json': '.json',
  'application/x-ndjson': '.jsonl',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/pdf': '.pdf',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-tar': '.tar',
  'application/wasm': '.wasm',
  'text/html': '.html',
  'text/css': '.css',
  'text/javascript': '.js',
}

interface ListEntry {
  key: string
  row: Document
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const UNSAFE_PROPERTY_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function setOwnMetadata(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function normalizeMetadata(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    throw new ValidationError('metadata must be a plain object with string values')
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_PROPERTY_KEYS.has(key)) {
      throw new ValidationError(`metadata key "${key}" is not allowed`)
    }
    if (typeof item !== 'string') {
      throw new ValidationError(`metadata["${key}"] must be a string`)
    }
    setOwnMetadata(out, key, item)
  }
  return out
}

function storedMetadata(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && !UNSAFE_PROPERTY_KEYS.has(key)) {
      setOwnMetadata(out, key, item)
    }
  }
  return out
}

function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1)
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) return ''
  return name.slice(index + 1).toLowerCase()
}

function mediaType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase()
}

function inferContentType(key: string): string {
  const extension = extensionOf(baseName(key))
  return extension ? (CONTENT_TYPES[extension] ?? 'application/octet-stream') : 'application/octet-stream'
}

function resolveContentType(key: string, explicit: unknown): string {
  if (explicit === undefined) return inferContentType(key)
  if (typeof explicit !== 'string' || explicit.trim().length === 0) {
    throw new ValidationError('contentType must be a non-empty string')
  }
  return explicit.trim()
}

function extensionForContentType(contentType: string): string {
  return EXTENSIONS[mediaType(contentType)] ?? '.bin'
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim()
}

function makeFileName(key: string, provided: string | undefined, contentType: string): string {
  if (provided !== undefined && (typeof provided !== 'string' || provided.trim().length === 0)) {
    throw new ValidationError('fileName must be a non-empty string')
  }
  let name = sanitizeFileName(provided ?? baseName(key))
  if (name.length === 0) name = 'object'
  name = name.slice(0, MAX_FILE_NAME_LENGTH)
  if (!extensionOf(name)) {
    const extension = extensionForContentType(contentType)
    name = name.slice(0, MAX_FILE_NAME_LENGTH - extension.length) + extension
  }
  return name
}

function firstAttachmentToken(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const item = Array.isArray(value) ? value[0] : value
  if (!item || typeof item !== 'object') return undefined
  const candidate = item as { fileToken?: unknown; file_token?: unknown }
  if (typeof candidate.fileToken === 'string' && candidate.fileToken.length > 0) {
    return candidate.fileToken
  }
  if (typeof candidate.file_token === 'string' && candidate.file_token.length > 0) {
    return candidate.file_token
  }
  return undefined
}

function objectNotFound(key: string, bucket: string): NotFoundError {
  return new NotFoundError(`Object "${key}" not found in bucket "${bucket}"`, { code: 'NoSuchKey' })
}

function attachmentToken(value: unknown, key: string, bucket: string): string {
  const token = firstAttachmentToken(value)
  if (!token) {
    throw new LarkflareError(
      `Object "${key}" in bucket "${bucket}" has an empty attachment cell; re-upload the object`,
      { code: 'InvalidAttachment' },
    )
  }
  return token
}

function isDuplicateIdError(error: unknown): boolean {
  return error instanceof ValidationError && /Duplicate _id/.test(error.message)
}

function metadataFromRow(
  key: string,
  row: Document,
  body: Buffer | undefined,
): R2ObjectMetadata {
  let size: number
  if (typeof row.size === 'number' && Number.isFinite(row.size)) size = row.size
  else size = body ? body.byteLength : 0

  let etag: string
  if (typeof row.etag === 'string' && row.etag.length > 0) etag = row.etag
  else etag = body ? sha256Hex(body) : ''

  const contentType =
    typeof row.content_type === 'string' && row.content_type.length > 0
      ? row.content_type
      : inferContentType(key)

  const updatedAt = row.updated_at
  const lastModified =
    updatedAt instanceof Date && !Number.isNaN(updatedAt.getTime()) ? updatedAt : new Date(0)

  return {
    key,
    size,
    etag,
    contentType,
    metadata: storedMetadata(row.metadata),
    lastModified,
  }
}

/**
 * One bucket, backed by a Larkflare database named `r2:<bucket>` whose
 * `objects` table holds one row per object.
 */
export class R2Bucket {
  readonly name: string

  private readonly client: Larkflare
  private readonly uploadMutex: Mutex
  private readonly publicUrls: PublicUrlPool
  private readonly listScanLimit: number

  private tableInstance?: Table
  private baseTokenValue?: string
  private ensurePromise?: Promise<void>

  constructor(context: R2BucketContext) {
    this.name = context.name
    this.client = context.client
    this.uploadMutex = context.uploadMutex
    this.publicUrls = context.publicUrls
    this.listScanLimit = context.listScanLimit
  }

  /** Lazily create or adopt the bucket Base and its `objects` table. */
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
    const database = this.client.useDatabase(`r2:${this.name}`)
    const table = database.defineTable(R2_OBJECTS_TABLE, R2_OBJECTS_SCHEMA)
    await table.ensure()
    this.tableInstance = table
    this.baseTokenValue = await database.getToken()
  }

  private async objects(): Promise<Table> {
    await this.ensure()
    if (!this.tableInstance) throw new LarkflareError('Bucket table is not initialised')
    return this.tableInstance
  }

  private requireBaseToken(): string {
    if (!this.baseTokenValue) throw new LarkflareError('Bucket Base token is not initialised')
    return this.baseTokenValue
  }

  /**
   * Look up a row by object key. Larkflare's `get()` also accepts raw Bitable
   * record ids (`rec...`) as a convenience; a missing object key that happens
   * to look like one must not alias an unrelated object.
   */
  private async findObject(table: Table, key: string): Promise<Document | null> {
    const row = await table.get(key)
    return row && row._id === key ? row : null
  }

  async putObject(
    key: string,
    body: R2Body,
    options: PutObjectOptions = {},
  ): Promise<R2HeadObjectResult> {
    validateKey(key)
    const bytes = await readBody(body)
    const metadata = normalizeMetadata(options.metadata)
    const contentType = resolveContentType(key, options.contentType)
    const fileName = makeFileName(key, options.fileName, contentType)

    const table = await this.objects()
    const parentType = mediaType(contentType).startsWith('image/') ? 'bitable_image' : 'bitable_file'
    const uploaded = await this.uploadMutex.runExclusive(() =>
      this.client.uploadMedia({
        parentToken: this.requireBaseToken(),
        bytes,
        fileName,
        parentType,
      }),
    )

    const etag = sha256Hex(bytes)
    const lastModified = new Date()
    const fields = {
      data: [{ file_token: uploaded.fileToken }],
      size: bytes.byteLength,
      etag,
      content_type: contentType,
      metadata,
      updated_at: lastModified,
    }

    const existing = await this.findObject(table, key)
    if (existing) {
      await table.updateOne({ _id: key }, fields)
    } else {
      try {
        await table.insertOne({ _id: key, ...fields })
      } catch (error) {
        if (!isDuplicateIdError(error)) throw error
        await table.updateOne({ _id: key }, fields)
      }
    }

    return {
      key,
      size: bytes.byteLength,
      etag,
      contentType,
      metadata,
      lastModified,
      fileToken: uploaded.fileToken,
    }
  }

  async headObject(key: string): Promise<R2HeadObjectResult> {
    validateKey(key)
    const table = await this.objects()
    const row = await this.findObject(table, key)
    if (!row) throw objectNotFound(key, this.name)
    return {
      ...metadataFromRow(key, row, undefined),
      fileToken: attachmentToken(row.data, key, this.name),
    }
  }

  async getObject(key: string): Promise<R2Object> {
    validateKey(key)
    const table = await this.objects()
    const row = await this.findObject(table, key)
    if (!row) throw objectNotFound(key, this.name)
    const fileToken = attachmentToken(row.data, key, this.name)
    // Download directly rather than through BlobManager's 128-entry cache so
    // large objects are not retained in memory by the shared client.
    const body = await this.client.downloadMedia(fileToken)
    return {
      ...metadataFromRow(key, row, body),
      fileToken,
      body,
    }
  }

  async deleteObject(key: string): Promise<boolean> {
    validateKey(key)
    const table = await this.objects()
    const row = await this.findObject(table, key)
    const fileToken = row ? firstAttachmentToken(row.data) : undefined
    const result = await table.deleteOne({ _id: key })
    if (fileToken) this.publicUrls.invalidate(fileToken)
    return result.deletedCount > 0
  }

  async listObjects(options: ListObjectsOptions = {}): Promise<R2ListObjectsResult> {
    const prefix = options.prefix ?? ''
    if (typeof prefix !== 'string') throw new ValidationError('prefix must be a string')
    const delimiter = options.delimiter
    if (delimiter !== undefined && (typeof delimiter !== 'string' || delimiter.length === 0)) {
      throw new ValidationError('delimiter must be a non-empty string')
    }
    if (options.limit !== undefined && !Number.isFinite(options.limit)) {
      throw new ValidationError('limit must be a finite number')
    }
    const limit = Math.min(
      MAX_LIST_LIMIT,
      Math.max(1, Math.floor(options.limit ?? DEFAULT_LIST_LIMIT)),
    )

    let after: string | undefined
    if (options.cursor !== undefined) after = decodeCursor(options.cursor)
    if (options.startAfter !== undefined) {
      validateKey(options.startAfter)
      if (after === undefined || options.startAfter > after) after = options.startAfter
    }

    const table = await this.objects()
    // Bitable has no prefix index: listing necessarily scans the bucket.
    const rows = await table
      .find({}, {
        limit: this.listScanLimit + 1,
        fields: ['size', 'etag', 'content_type', 'updated_at'],
      })
      .toArray()
    if (rows.length > this.listScanLimit) {
      throw new LarkflareError(
        `Bucket "${this.name}" has more than ${this.listScanLimit} objects. ` +
          `listObjects scans the whole bucket; raise listScanLimit to scan further.`,
        { code: 'ListScanLimitExceeded' },
      )
    }

    const entries: ListEntry[] = rows
      .filter((row) => typeof row._id === 'string' && row._id.startsWith(prefix))
      .filter((row) => after === undefined || (row._id as string) > after)
      .map((row) => ({ key: row._id as string, row }))
      .sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      )

    const objects: R2ObjectMetadata[] = []
    const commonPrefixes: string[] = []
    let lastConsumed: string | undefined
    let index = 0

    while (index < entries.length && objects.length + commonPrefixes.length < limit) {
      const entry = entries[index]!
      const delimiterIndex =
        delimiter === undefined ? -1 : entry.key.indexOf(delimiter, prefix.length)
      if (delimiter !== undefined && delimiterIndex >= 0) {
        const commonPrefix = entry.key.slice(0, delimiterIndex + delimiter.length)
        commonPrefixes.push(commonPrefix)
        // Consume the whole consecutive group so the next cursor starts after it.
        while (index < entries.length && entries[index]!.key.startsWith(commonPrefix)) {
          lastConsumed = entries[index]!.key
          index++
        }
        continue
      }
      objects.push(metadataFromRow(entry.key, entry.row, undefined))
      lastConsumed = entry.key
      index++
    }

    const isTruncated = index < entries.length
    const result: R2ListObjectsResult = { objects, commonPrefixes, isTruncated }
    if (isTruncated && lastConsumed !== undefined) {
      result.nextContinuationToken = encodeCursor(lastConsumed)
    }
    return result
  }

  async getPublicUrl(key: string): Promise<string> {
    validateKey(key)
    const table = await this.objects()
    const row = await this.findObject(table, key)
    if (!row) throw objectNotFound(key, this.name)
    return this.publicUrls.get(attachmentToken(row.data, key, this.name))
  }

  async getPublicUrls(keys: string[]): Promise<Record<string, string>> {
    if (!Array.isArray(keys)) throw new ValidationError('getPublicUrls expects an array of keys')
    for (const key of keys) validateKey(key)
    const uniqueKeys = [...new Set(keys)]
    if (uniqueKeys.length === 0) return {}

    // One batched row read, then one synchronous burst of pool lookups so the
    // pool can coalesce all tokens into as few Feishu calls as possible.
    const table = await this.objects()
    const rows = await table.batchGet(uniqueKeys)
    const tokens = new Map<string, string>()
    uniqueKeys.forEach((key, index) => {
      const row = rows[index]
      if (!row || row._id !== key) throw objectNotFound(key, this.name)
      tokens.set(key, attachmentToken(row.data, key, this.name))
    })

    const urls = await Promise.all(uniqueKeys.map((key) => this.publicUrls.get(tokens.get(key)!)))
    const byKey = new Map(uniqueKeys.map((key, index) => [key, urls[index]!]))
    return Object.fromEntries(keys.map((key) => [key, byKey.get(key)!]))
  }

  put(key: string, body: R2Body, options?: PutObjectOptions): Promise<R2HeadObjectResult> {
    return this.putObject(key, body, options)
  }

  get(key: string): Promise<R2Object> {
    return this.getObject(key)
  }

  head(key: string): Promise<R2HeadObjectResult> {
    return this.headObject(key)
  }

  delete(key: string): Promise<boolean> {
    return this.deleteObject(key)
  }

  list(options?: ListObjectsOptions): Promise<R2ListObjectsResult> {
    return this.listObjects(options)
  }
}
