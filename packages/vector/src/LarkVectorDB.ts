/**
 * Two-stage multimodal vector search on top of Larkbase.
 *
 * Stage 1 (rough rank) runs entirely in this process: the query embedding is
 * quantized to a 512-bit sketch and compared against the in-memory
 * {@link VectorSnapshot} with Hamming distance.
 *
 * Stage 2 (fetch) takes the winning logical ids and asks Bitable for the
 * canonical rows, which carry the full composite chunk and its media
 * references. No external vector database, no cache server, no extra
 * infrastructure: Bitable is the source of truth and the snapshot file is just
 * a rebuildable accelerator.
 */
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import type { WithId } from '@larkbase/core'
import { quantizeToBinary } from './math.js'
import { VectorSnapshot, assertRecordIdFits } from './snapshot.js'
import type {
  CompositeChunk,
  LarkVectorDBOptions,
  VectorMatch,
  VectorRecord,
  VectorTable,
  VectorUpsertResult,
} from './types.js'
import { DEFAULT_DIMENSIONS } from './types.js'

/** Bitable field holding `context_text`. */
export const CONTEXT_TEXT_FIELD = 'context_text'
/** Bitable field holding the chunk's source object. */
export const SOURCE_FIELD = 'source'
/** Bitable field holding the media reference array. */
export const MEDIA_FIELD = 'media'
/** Bitable field holding the caller's metadata object. */
export const METADATA_FIELD = 'metadata'
/** Bitable field holding the Base64 1-bit sketch. */
export const VECTOR_B64_FIELD = 'vector_b64'
/** Bitable field holding the embedding dimensionality. */
export const DIMENSIONS_FIELD = 'dimensions'
/** Bitable field holding the last write timestamp. */
export const UPDATED_AT_FIELD = 'updated_at'

/**
 * Declarative schema for the backing table.
 *
 * Pass it to `database.defineTable('chunks', VECTOR_TABLE_SCHEMA)` (or merge
 * it into your own schema) before constructing a {@link LarkVectorDB}.
 */
export const VECTOR_TABLE_SCHEMA = {
  [CONTEXT_TEXT_FIELD]: 'text',
  [SOURCE_FIELD]: 'json',
  [MEDIA_FIELD]: 'json',
  [METADATA_FIELD]: 'json',
  [VECTOR_B64_FIELD]: 'text',
  [DIMENSIONS_FIELD]: 'number',
  [UPDATED_AT_FIELD]: 'date',
} as const

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Mint a 16-character Crockford Base32 id.
 *
 * 16 ASCII characters occupy exactly the default 16-byte snapshot slot, so
 * generated ids never need truncation or hashing. The 80 random bits make
 * collisions practically irrelevant for a Bitable-sized corpus.
 */
export function createRecordId(): string {
  const bytes = randomBytes(16)
  let id = ''
  for (let i = 0; i < 16; i++) {
    id += CROCKFORD[bytes[i]! & 31]!
  }
  return id
}

/**
 * Zero-infrastructure vector database over a Larkbase table.
 *
 * @typeParam C - Concrete {@link CompositeChunk} shape used by the caller.
 *
 * @example
 * ```ts
 * const chunks = db
 *   .useDatabase('knowledge')
 *   .defineTable('chunks', VECTOR_TABLE_SCHEMA)
 *
 * const vector = new LarkVectorDB(chunks)
 * await vector.upsert(
 *   {
 *     id: createRecordId(),
 *     source: { doc_token: 'doxcn...', block_id: 'blk...' },
 *     media: [{ file_token: 'boxcn...', type: 'image', caption: '架构图' }],
 *     context_text: '写入路径先落 Bitable，再更新本地二值索引。',
 *     metadata: { lang: 'zh' },
 *   },
 *   embedding, // 512 floats
 * )
 *
 * const hits = await vector.search(queryEmbedding, 5)
 * ```
 */
export class LarkVectorDB<C extends CompositeChunk = CompositeChunk> {
  readonly #table: VectorTable<VectorRecord<C>>
  readonly #dimensions: number
  #snapshot: VectorSnapshot

  /**
   * @param table - A Larkbase table (or any object implementing
   *   {@link VectorTable}) whose schema follows {@link VECTOR_TABLE_SCHEMA}.
   * @param options - Dimensionality, id slot width, initial capacity and an
   *   optional snapshot to load immediately.
   */
  constructor(table: VectorTable<VectorRecord<C>>, options: LarkVectorDBOptions = {}) {
    if (!table || typeof table !== 'object') {
      throw new TypeError('LarkVectorDB requires a Larkbase table')
    }
    for (const method of ['insertOne', 'updateById', 'batchGet'] as const) {
      if (typeof table[method] !== 'function') {
        throw new TypeError(`LarkVectorDB table is missing ${method}()`)
      }
    }

    const dimensions =
      options.dimensions ??
      (options.vectorBytes !== undefined ? options.vectorBytes * 8 : DEFAULT_DIMENSIONS)
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new RangeError('dimensions must be a positive integer')
    }
    if (dimensions % 8 !== 0) {
      throw new RangeError('dimensions must be a multiple of 8 so they pack into whole bytes')
    }
    const vectorBytes = dimensions >>> 3
    if (vectorBytes % 4 !== 0) {
      // The scanner compares 32-bit words; 512 dims -> 64 bytes is aligned.
      throw new RangeError('dimensions must be a multiple of 32 so each sketch is 4-byte aligned')
    }
    if (options.vectorBytes !== undefined && options.vectorBytes !== vectorBytes) {
      throw new RangeError(
        `options.vectorBytes ${options.vectorBytes} does not match dimensions ${dimensions}`,
      )
    }

    this.#table = table
    this.#dimensions = dimensions
    this.#snapshot = new VectorSnapshot({
      ...(options.idBytes !== undefined ? { idBytes: options.idBytes } : {}),
      vectorBytes,
      ...(options.initialCapacity !== undefined
        ? { initialCapacity: options.initialCapacity }
        : {}),
    })
    if (options.snapshot) this.loadSnapshot(options.snapshot)
  }

  /** Embedding dimensionality accepted by {@link upsert} and {@link search}. */
  get dimensions(): number {
    return this.#dimensions
  }

  /** Bytes per packed sketch (`dimensions / 8`). */
  get vectorBytes(): number {
    return this.#dimensions >>> 3
  }

  /** Number of vectors currently indexed in memory. */
  get size(): number {
    return this.#snapshot.size
  }

  /** Id slot width of the active snapshot. */
  get idBytes(): number {
    return this.#snapshot.idBytes
  }

  /**
   * Replace the in-memory index with a snapshot produced by
   * {@link exportSnapshot} (or {@link VectorSnapshot.toBuffer}).
   *
   * The snapshot's dimensionality and id width must match the configuration,
   * otherwise the ids and vectors would not be comparable.
   *
   * @returns `this`, so the call can be chained.
   */
  loadSnapshot(buffer: Buffer | Uint8Array): this {
    const snapshot = VectorSnapshot.fromBuffer(buffer)
    if (snapshot.dimensions !== this.#dimensions) {
      throw new RangeError(
        `snapshot has ${snapshot.dimensions} dimensions but this database expects ${this.#dimensions}`,
      )
    }
    if (snapshot.idBytes !== this.#snapshot.idBytes) {
      throw new RangeError(
        `snapshot id slots are ${snapshot.idBytes} bytes but this database uses ${this.#snapshot.idBytes}`,
      )
    }
    this.#snapshot = snapshot
    return this
  }

  /**
   * Serialize the current index for durable storage.
   *
   * Upload this buffer to Feishu Drive (or store it as a Bitable attachment)
   * and pass it back to {@link loadSnapshot} on the next cold start.
   */
  exportSnapshot(): Buffer {
    return this.#snapshot.toBuffer()
  }

  /**
   * Persist a composite chunk and update its 1-bit sketch.
   *
   * Order matters: the Bitable row is written first, then the in-memory index
   * is updated. If the write fails, the index is left untouched and a retry is
   * safe (logical ids are idempotent upserts). The stored `vector_b64` makes
   * the index rebuildable if the snapshot file is ever lost.
   *
   * @param chunk - Composite chunk to insert or replace.
   * @param floatVector - Normalized embedding of `context_text + media
   *   captions`, length must equal {@link dimensions}.
   * @returns Whether a new row was created and the packed size.
   */
  async upsert(chunk: C, floatVector: ArrayLike<number>): Promise<VectorUpsertResult> {
    assertChunk(chunk)
    assertEmbedding(floatVector, this.#dimensions)
    assertRecordIdFits(chunk.id, this.#snapshot.idBytes)

    const packed = quantizeToBinary(floatVector)
    const record: VectorRecord<C> = {
      [CONTEXT_TEXT_FIELD]: chunk.context_text,
      [SOURCE_FIELD]: chunk.source,
      [MEDIA_FIELD]: chunk.media,
      [METADATA_FIELD]: chunk.metadata,
      [VECTOR_B64_FIELD]: Buffer.from(packed).toString('base64'),
      [DIMENSIONS_FIELD]: this.#dimensions,
      [UPDATED_AT_FIELD]: new Date(),
    } as VectorRecord<C>

    const update = await this.#table.updateById(chunk.id, record)
    let created = false
    if (update.matchedCount === 0) {
      await this.#table.insertOne({ _id: chunk.id, ...record })
      created = true
    }

    this.#snapshot.add(chunk.id, packed)
    return {
      recordId: chunk.id,
      created,
      dimensions: this.#dimensions,
      vectorBytes: packed.length,
    }
  }

  /**
   * Two-stage search: rough-rank in memory, then fetch the winners from
   * Bitable in one batch.
   *
   * Hits whose Bitable row disappeared (for example because records were
   * deleted out-of-band) are skipped rather than throwing, so a stale snapshot
   * degrades gracefully; call {@link exportSnapshot} after ingest to refresh
   * the persisted index.
   *
   * @param queryFloatVector - Embedding of the query, same dimensionality as
   *   the indexed vectors.
   * @param topK - Number of candidates to rough-rank and fetch. Defaults to 5.
   */
  async search(
    queryFloatVector: ArrayLike<number>,
    topK: number = 5,
  ): Promise<Array<VectorMatch<C>>> {
    assertEmbedding(queryFloatVector, this.#dimensions)
    const query = quantizeToBinary(queryFloatVector)
    const rough = this.#snapshot.searchRoughDetailed(query, topK)
    if (rough.length === 0) return []

    const documents = await this.#table.batchGet(rough.map((match) => match.recordId))
    const byId = new Map<string, WithId<VectorRecord<C>>>()
    for (const document of documents) {
      if (document) byId.set(document._id, document)
    }

    const matches: Array<VectorMatch<C>> = []
    for (const hit of rough) {
      const document = byId.get(hit.recordId)
      if (!document) continue
      if (document[DIMENSIONS_FIELD] !== this.#dimensions) {
        throw new RangeError(
          `record "${hit.recordId}" was stored with ${String(document[DIMENSIONS_FIELD])} ` +
            `dimensions but this database expects ${this.#dimensions}`,
        )
      }
      matches.push({
        recordId: hit.recordId,
        distance: hit.distance,
        chunk: rowToChunk<C>(document),
        document,
      })
    }
    return matches
  }
}

function assertChunk(chunk: CompositeChunk): void {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
    throw new TypeError('chunk must be a CompositeChunk object')
  }
  if (typeof chunk.id !== 'string' || chunk.id.length === 0) {
    throw new TypeError('chunk.id must be a non-empty string')
  }
  if (typeof chunk.context_text !== 'string') {
    throw new TypeError('chunk.context_text must be a string')
  }
  if (!Array.isArray(chunk.media)) {
    throw new TypeError('chunk.media must be an array of MediaRef objects')
  }
  if (!isPlainObject(chunk.source)) {
    throw new TypeError('chunk.source must be an object')
  }
  if (!isPlainObject(chunk.metadata)) {
    throw new TypeError('chunk.metadata must be an object')
  }
}

function assertEmbedding(vector: ArrayLike<number>, dimensions: number): void {
  if (vector === null || vector === undefined || typeof vector.length !== 'number') {
    throw new TypeError('embedding must be an array-like of numbers')
  }
  if (vector.length !== dimensions) {
    throw new RangeError(`embedding must have ${dimensions} dimensions; got ${vector.length}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rowToChunk<C extends CompositeChunk>(row: WithId<VectorRecord<C>>): C {
  return {
    id: row._id,
    source: (row[SOURCE_FIELD] as C['source'] | undefined) ?? {},
    media: (row[MEDIA_FIELD] as C['media'] | undefined) ?? [],
    context_text:
      typeof row[CONTEXT_TEXT_FIELD] === 'string' ? (row[CONTEXT_TEXT_FIELD] as string) : '',
    metadata: (row[METADATA_FIELD] as C['metadata'] | undefined) ?? ({} as C['metadata']),
  } as C
}
