import type { SchemaDefinition } from '@larkflare/db'

/** Name of the Bitable table that stores objects inside a bucket Base. */
export const R2_OBJECTS_TABLE = 'objects'

/**
 * Row schema. `_id` is the object key; `data` references the Feishu media
 * upload; the remaining columns carry the S3-style object metadata.
 */
export const R2_OBJECTS_SCHEMA: SchemaDefinition = {
  data: 'attachment',
  size: 'number',
  etag: 'text',
  content_type: 'text',
  metadata: 'json',
  updated_at: 'date',
}

/** Accepted request bodies for {@link R2Bucket.putObject}. */
export type R2Body = Buffer | Uint8Array | ArrayBuffer | string | Blob | AsyncIterable<Uint8Array>

export interface R2ObjectMetadata {
  key: string
  size: number
  etag: string
  contentType: string
  metadata: Record<string, string>
  lastModified: Date
}

export interface R2HeadObjectResult extends R2ObjectMetadata {
  /** Feishu Drive media token backing the object bytes. */
  fileToken: string
}

export interface R2Object extends R2HeadObjectResult {
  body: Buffer
}

export interface PutObjectOptions {
  contentType?: string
  metadata?: Record<string, string>
  fileName?: string
}

export interface ListObjectsOptions {
  prefix?: string
  delimiter?: string
  cursor?: string
  startAfter?: string
  limit?: number
}

export interface R2ListObjectsResult {
  objects: R2ObjectMetadata[]
  commonPrefixes: string[]
  isTruncated: boolean
  nextContinuationToken?: string
}

export interface R2BucketInfo {
  name: string
  baseToken: string
}
