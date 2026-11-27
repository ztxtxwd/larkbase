import { BlobRef, ValidationError, type Document } from '@larkflare/db'
import { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { ReadableStream } from 'node:stream/web'
import {
  KV_INLINE_BINARY_BYTES,
  KV_MAX_METADATA_BYTES,
  KV_MAX_VALUE_BYTES,
  KV_MIN_EXPIRATION_SECONDS,
  type KVPutOptions,
  type KVValue,
} from './types.js'

/** Storage columns written for one key. */
export interface EncodedValue {
  encoding: 'utf8' | 'base64' | 'attachment'
  value: string | null
  data: Buffer | null
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getReader?: unknown }).getReader === 'function'
  )
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) {
        throw new ValidationError('ReadableStream value must yield Uint8Array chunks')
      }
      total += value.byteLength
      if (total > KV_MAX_VALUE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ValidationError(`Value must be at most ${KV_MAX_VALUE_BYTES} bytes`)
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released by cancel() */
    }
  }
  return Buffer.concat(chunks, total)
}

function valueTooLarge(): never {
  throw new ValidationError(`Value must be at most ${KV_MAX_VALUE_BYTES} bytes`)
}

/**
 * Normalise an accepted value into the three storage columns. Strings keep
 * their text form (DB spills large ones to Drive); small binary is base64
 * inlined; larger binary becomes a Bitable attachment.
 */
export async function normalizeValue(value: KVValue): Promise<EncodedValue> {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > KV_MAX_VALUE_BYTES) valueTooLarge()
    return { encoding: 'utf8', value, data: null }
  }

  let bytes: Buffer
  if (value instanceof ArrayBuffer) {
    bytes = Buffer.from(value)
  } else if (ArrayBuffer.isView(value)) {
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  } else if (isReadableStream(value)) {
    bytes = await readStream(value)
  } else {
    throw new ValidationError(
      'Unsupported value type: expected string, ArrayBuffer, ArrayBufferView or ReadableStream<Uint8Array>',
    )
  }

  if (bytes.byteLength > KV_MAX_VALUE_BYTES) valueTooLarge()
  if (bytes.byteLength <= KV_INLINE_BINARY_BYTES) {
    return { encoding: 'base64', value: bytes.toString('base64'), data: null }
  }
  return { encoding: 'attachment', value: null, data: bytes }
}

function isBlobRef(value: unknown): value is BlobRef {
  return (
    value instanceof BlobRef ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { bytes?: unknown }).bytes === 'function' &&
      typeof (value as { fileToken?: unknown }).fileToken === 'string')
  )
}

/** Materialise a DB text/blob cell into a string. */
async function readText(value: unknown): Promise<string> {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8')
  if (isBlobRef(value)) return (await value.bytes()).toString('utf8')
  if (Array.isArray(value)) {
    let text = ''
    for (const item of value) text += await readText(item)
    return text
  }
  if (typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return (value as { text: string }).text
  }
  return String(value)
}

/** Materialise a DB blob cell (attachment list, BlobRef, Buffer or array) into bytes. */
async function readBytes(value: unknown): Promise<Buffer> {
  if (value === null || value === undefined) return Buffer.alloc(0)
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (isBlobRef(value)) return value.bytes()
  if (Array.isArray(value)) {
    for (const item of value) {
      const bytes = await readBytes(item)
      if (bytes.byteLength > 0) return bytes
    }
    return Buffer.alloc(0)
  }
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return Buffer.from((value as { text: string }).text, 'utf8')
  }
  return Buffer.alloc(0)
}

/**
 * Decode a stored row into the raw bytes of its value. `encoding` is storage
 * metadata only: `utf8` text and base64 binary both round-trip through the
 * same callers, so a string may be read back as binary and vice versa.
 */
export async function storedValueBytes(row: Document): Promise<Buffer> {
  const encoding = row.encoding
  if (encoding === 'utf8') {
    return Buffer.from(await readText(row.value), 'utf8')
  }
  if (encoding === 'base64') {
    return Buffer.from(await readText(row.value), 'base64')
  }
  if (encoding === 'attachment') {
    return readBytes(row.data)
  }
  // Unknown or missing encoding: prefer attachment bytes, otherwise UTF-8 text.
  const dataBytes = await readBytes(row.data)
  if (dataBytes.byteLength > 0) return dataBytes
  return Buffer.from(await readText(row.value), 'utf8')
}

/** Copy the bytes into a standalone ArrayBuffer. */
export function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** A one-chunk ReadableStream that enqueues exactly the stored bytes. */
export function toReadableStream(bytes: Buffer): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(bytes.byteLength)
  chunk.set(bytes)
  return new NodeReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    },
  })
}

/**
 * Validate metadata and normalise absent values to null. JSON.stringify must
 * succeed and produce at most 1024 UTF-8 bytes.
 */
export function validateMetadata(metadata: unknown): unknown {
  if (metadata === undefined || metadata === null) return null
  let json: string | undefined
  try {
    json = JSON.stringify(metadata)
  } catch (error) {
    throw new ValidationError('metadata must be JSON-serializable', { cause: error })
  }
  if (json === undefined) {
    throw new ValidationError('metadata must be JSON-serializable')
  }
  if (Buffer.byteLength(json, 'utf8') > KV_MAX_METADATA_BYTES) {
    throw new ValidationError(`metadata must be at most ${KV_MAX_METADATA_BYTES} UTF-8 bytes`)
  }
  return metadata
}

/**
 * Resolve `expiration` / `expirationTtl` to integer epoch seconds. Both are
 * mutually exclusive and must be at least 60 seconds in the future.
 */
export function resolveExpiration(options: KVPutOptions): number | null {
  const hasExpiration = options.expiration !== undefined && options.expiration !== null
  const hasTtl = options.expirationTtl !== undefined && options.expirationTtl !== null
  if (hasExpiration && hasTtl) {
    throw new ValidationError('expiration and expirationTtl are mutually exclusive')
  }

  const now = Math.floor(Date.now() / 1000)
  if (hasExpiration) {
    if (typeof options.expiration !== 'number' || !Number.isFinite(options.expiration)) {
      throw new ValidationError('expiration must be a finite number of epoch seconds')
    }
    const expiration = Math.floor(options.expiration)
    if (expiration < now + KV_MIN_EXPIRATION_SECONDS) {
      throw new ValidationError(
        `expiration must be at least ${KV_MIN_EXPIRATION_SECONDS} seconds in the future`,
      )
    }
    return expiration
  }
  if (hasTtl) {
    if (typeof options.expirationTtl !== 'number' || !Number.isFinite(options.expirationTtl)) {
      throw new ValidationError('expirationTtl must be a finite number of seconds')
    }
    const ttl = Math.floor(options.expirationTtl)
    if (ttl < KV_MIN_EXPIRATION_SECONDS) {
      throw new ValidationError(`expirationTtl must be at least ${KV_MIN_EXPIRATION_SECONDS} seconds`)
    }
    return now + ttl
  }
  return null
}
