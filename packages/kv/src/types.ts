import type { SchemaDefinition } from '@larkflare/db'
import type { ReadableStream } from 'node:stream/web'

/** A value accepted by {@link KVNamespace.put}. */
export type KVValue = string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>

/** The view {@link KVNamespace.get} materialises a stored value into. */
export type KVValueType = 'text' | 'json' | 'arrayBuffer' | 'stream'

export interface KVGetOptions<Type extends KVValueType = KVValueType> {
  type?: Type
  /** Accepted for Workers KV compatibility; this adapter performs no edge caching. */
  cacheTtl?: number
}

export interface KVPutOptions {
  expiration?: number
  expirationTtl?: number
  metadata?: unknown
}

export interface KVListOptions {
  limit?: number
  prefix?: string | null
  cursor?: string | null
}

export interface KVListKey<Metadata = unknown> {
  name: string
  expiration?: number
  metadata?: Metadata
}

export type KVListResult<Metadata = unknown> =
  | { keys: Array<KVListKey<Metadata>>; list_complete: false; cursor: string }
  | { keys: Array<KVListKey<Metadata>>; list_complete: true; cursor?: undefined }

export interface KVGetWithMetadataResult<Value = unknown, Metadata = unknown> {
  value: Value | null
  metadata: Metadata | null
}

export interface KVNamespaceInfo {
  name: string
  baseToken: string
}

/** Name of the Bitable table that stores entries inside a namespace Base. */
export const KV_ENTRIES_TABLE = 'entries'

/** Values whose UTF-8 size reaches this limit are spilled to Feishu Drive. */
export const KV_TEXT_SPILL_BYTES = 32 * 1024

/** Binary values up to this size are base64-inlined instead of uploaded. */
export const KV_INLINE_BINARY_BYTES = 16 * 1024

/** Maximum key length in UTF-8 bytes. */
export const KV_MAX_KEY_BYTES = 512

/** Maximum value size in bytes. */
export const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024

/** Maximum serialised metadata size in bytes. */
export const KV_MAX_METADATA_BYTES = 1024

/** Minimum accepted TTL / absolute expiration distance in seconds. */
export const KV_MIN_EXPIRATION_SECONDS = 60

/**
 * Row schema for a namespace's `entries` table. `_id` is the key; `encoding`,
 * `value` and `data` describe where the bytes live; `metadata` and
 * `expiration` mirror the Workers KV put options.
 */
export const KV_ENTRIES_SCHEMA: SchemaDefinition = {
  encoding: 'text',
  value: { type: 'text', spill: KV_TEXT_SPILL_BYTES },
  data: 'blob',
  metadata: 'json',
  expiration: 'number',
}
