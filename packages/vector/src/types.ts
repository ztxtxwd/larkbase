/**
 * Public data model for `@larkbase/vector`.
 *
 * A row in the underlying Bitable table is a *composite chunk*: a piece of
 * text whose meaning is anchored by surrounding text semantics and by the
 * multimodal assets (image / audio / video) it points at. The vector index
 * itself never stores the float embedding: only a 1-bit quantized sketch is
 * kept in memory and in the snapshot file, while the canonical record lives in
 * Bitable.
 */
import type { Document, UpdateSpec, WithId } from '@larkbase/core'

/** Default embedding dimensionality handled by the index. */
export const DEFAULT_DIMENSIONS = 512

/** Fixed width of a record id slot inside the flat snapshot buffer. */
export const DEFAULT_ID_BYTES = 16

/** Kind of multimodal asset referenced by a chunk. */
export type MediaType = 'image' | 'audio' | 'video'

/** A half-open time range inside an audio or video asset. */
export interface MediaTimeRange {
  /** Start offset in milliseconds (inclusive). */
  start_ms: number
  /** End offset in milliseconds (exclusive). Omit for "until the end". */
  end_ms?: number
}

/** Reference to an asset stored in Feishu Drive. */
export interface MediaRef {
  /** Feishu Drive `file_token` of the asset. */
  file_token: string
  /** Asset kind. */
  type: MediaType
  /** Slice of the asset this chunk talks about. */
  time_range?: MediaTimeRange
  /** Optional MIME type, e.g. `image/png` or `audio/ogg`. */
  mime_type?: string
  /** Original file name, useful when resolving `file_token` later. */
  name?: string
  /** Text caption or ASR/OCR summary used to anchor the asset semantically. */
  caption?: string
  /** Free-form attributes (width, height, duration_ms, ...). */
  metadata?: Record<string, unknown>
}

/**
 * Where a chunk came from.
 *
 * Feishu exposes several token families (`docx` document tokens, wiki node
 * tokens, block ids, ...); not every source has all of them, so the fields are
 * optional but the object itself is always present.
 */
export interface ChunkSource {
  /** Feishu document token (docx document id, wiki node token, ...). */
  doc_token?: string
  /** Block id inside the document when the chunk maps to a single block. */
  block_id?: string
  /** Deep link back to the source, when the caller has one. */
  url?: string
  /** Free-form origin attributes (sheet id, page number, timestamp, ...). */
  metadata?: Record<string, unknown>
}

/**
 * The unit stored by the vector layer.
 *
 * `context_text` is the semantic anchor: the expert conclusion or surrounding
 * prose that gives the media its meaning. The media references point at the
 * actual bytes in Feishu Drive and are resolved lazily by the application.
 *
 * @typeParam M - Shape of the caller's custom metadata payload.
 */
export interface CompositeChunk<M extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Stable logical id. It is used as the Bitable `_id` and as the key inside
   * the binary snapshot, so its UTF-8 encoding must fit the snapshot's
   * `idBytes` slot (16 bytes by default). Use {@link createRecordId} to mint an
   * id that always fits.
   */
  id: string
  /** Provenance of the chunk. */
  source: ChunkSource
  /** Multimodal assets referenced by the chunk. May be empty for pure text. */
  media: MediaRef[]
  /** Text that anchors the chunk semantically. */
  context_text: string
  /** Caller-defined payload (tags, language, expert confidence, ...). */
  metadata: M
}

/**
 * A 1-bit quantized vector.
 *
 * For the default 512 dimensions this is exactly 64 bytes. Byte `i >> 3`,
 * bit `i & 7` (least-significant bit first) holds dimension `i`: `1` when the
 * original coordinate was `> 0`, `0` otherwise.
 */
export interface BinaryVector {
  /** Packed bits, `ceil(dimensions / 8)` bytes. */
  data: Uint8Array
  /** Number of original float dimensions. */
  dimensions: number
}

/**
 * Physical Bitable row backing one composite chunk.
 *
 * Field names are also exported as constants from `LarkVectorDB.ts`; keep the
 * declarative schema (`VECTOR_TABLE_SCHEMA`) in sync if you change them.
 */
export interface VectorRecord<C extends CompositeChunk = CompositeChunk> extends Document {
  /** Logical chunk id, mirrored into Bitable's `_id` field. */
  _id?: string
  context_text: string
  source: ChunkSource
  media: MediaRef[]
  metadata: C['metadata']
  /** Base64 of the packed 1-bit vector (88 chars for the default 512 dims). */
  vector_b64: string
  /** Dimensionality of the original float embedding. */
  dimensions: number
  /** Last write time. */
  updated_at: Date | number
}

/**
 * Minimal structural contract `LarkVectorDB` needs from a Larkbase table.
 *
 * The concrete `Table<T>` from `@larkbase/core` satisfies it; tests and custom
 * backends can provide their own implementation without importing core at
 * runtime.
 */
export interface VectorTable<T extends Document = Document> {
  insertOne(doc: T): Promise<WithId<T>>
  updateById(id: string, update: UpdateSpec<T>): Promise<{ matchedCount: number }>
  batchGet(ids: string[]): Promise<Array<WithId<T> | null>>
}

/** One rough-rank hit produced by {@link VectorSnapshot.searchRoughDetailed}. */
export interface RoughMatch {
  /** Logical record id stored in the snapshot. */
  recordId: string
  /** Hamming distance in bits. Lower is closer; range `[0, dimensions]`. */
  distance: number
}

/** Options accepted by {@link VectorSnapshot}. */
export interface VectorSnapshotOptions {
  /** Fixed slot size for ids, in bytes. Defaults to 16. */
  idBytes?: number
  /** Packed vector size in bytes; must be a multiple of 4. Defaults to 64. */
  vectorBytes?: number
  /** Initial number of slots. The buffer grows geometrically. Defaults to 64. */
  initialCapacity?: number
}

/** Options accepted by {@link LarkVectorDB}. */
export interface LarkVectorDBOptions extends VectorSnapshotOptions {
  /** Embedding dimensionality, defaults to 512. Must equal `vectorBytes * 8`. */
  dimensions?: number
  /** Optional snapshot to load at construction time. */
  snapshot?: Buffer | Uint8Array
}

/** Result of a successful {@link LarkVectorDB.upsert}. */
export interface VectorUpsertResult {
  /** Logical chunk id. */
  recordId: string
  /** `true` when a new Bitable row was created, `false` when it was updated. */
  created: boolean
  /** Embedding dimensionality. */
  dimensions: number
  /** Bytes occupied by the packed vector (64 for 512 dims). */
  vectorBytes: number
}

/** One two-stage-search hit. */
export interface VectorMatch<C extends CompositeChunk = CompositeChunk> {
  /** Logical chunk id. */
  recordId: string
  /** Hamming distance of the 1-bit sketches. Lower is closer. */
  distance: number
  /** Reconstructed composite chunk. */
  chunk: C
  /** Full Bitable document, including `vector_b64` and timestamps. */
  document: WithId<VectorRecord<C>>
}
