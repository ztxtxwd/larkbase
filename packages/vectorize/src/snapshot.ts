/**
 * Compact in-memory vector index.
 *
 * Layout: one flat, interleaved arena of fixed-size entries
 *
 * ```text
 * [ record id: idBytes ][ packed vector: vectorBytes ] [ record id ] [ packed vector ] ...
 * ```
 *
 * With the defaults (`idBytes = 16`, `vectorBytes = 64`) an entry is 80 bytes,
 * so 1,000,000 chunks occupy ~80 MB. There are no objects, no pointers and no
 * per-entry allocation on the search path: rough ranking walks the arena with
 * 32-bit XOR/popcount operations and keeps only a K-element heap.
 *
 * The record id is stored as zero-padded UTF-8. Ids must not contain NUL,
 * which makes padding unambiguous. Bytes past the id are zero-filled; the
 * snapshot file records `idBytes` so it can be reopened on another machine.
 */
import { Buffer } from 'node:buffer'
import { popcount32, toAlignedWords } from './math.js'
import type { RoughMatch, VectorSnapshotOptions } from './types.js'
import { DEFAULT_DIMENSIONS, DEFAULT_ID_BYTES } from './types.js'

const MAGIC = 'LFVS'
/** Snapshots written before the Larkflare rename. */
const LEGACY_MAGIC = 'LKVS'
const VERSION = 1
const HEADER_BYTES = 32
const MIN_EXPANSION = 64

const OFF_MAGIC = 0
const OFF_VERSION = 4
const OFF_HEADER_BYTES = 6
const OFF_ID_BYTES = 8
const OFF_VECTOR_BYTES = 10
const OFF_DIMENSIONS = 12
const OFF_COUNT = 16
const OFF_CHECKSUM = 20

/**
 * Validate that an id fits a snapshot slot before any durable write happens.
 *
 * @param recordId - Logical id to validate.
 * @param idBytes - Slot width in bytes (normally 16).
 * @throws {TypeError} If `recordId` is not a non-empty string.
 * @throws {RangeError} If the UTF-8 encoding is too long or contains NUL.
 */
export function assertRecordIdFits(recordId: string, idBytes: number = DEFAULT_ID_BYTES): void {
  if (typeof recordId !== 'string' || recordId.length === 0) {
    throw new TypeError('record id must be a non-empty string')
  }
  if (recordId.includes('\0')) {
    throw new RangeError('record id must not contain NUL bytes')
  }
  const bytes = Buffer.byteLength(recordId, 'utf8')
  if (bytes > idBytes) {
    throw new RangeError(
      `record id "${recordId}" encodes to ${bytes} bytes but the snapshot slot is ${idBytes} bytes; ` +
        `use a shorter id (createRecordId() returns a 16-byte one) or raise idBytes`,
    )
  }
}

/** FNV-1a, used only to detect truncated or corrupted snapshot files. */
function fnv1a32(buffer: Uint8Array, start: number, end: number): number {
  let hash = 0x811c9dc5
  for (let i = start; i < end; i++) {
    hash ^= buffer[i]!
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Min-heap ordered by "worse first": larger distance, then larger index. */
function isWorse(ax: number, ay: number, bx: number, by: number): boolean {
  return ax > bx || (ax === bx && ay > by)
}

/**
 * A flat, growable 1-bit vector index.
 *
 * @example
 * ```ts
 * const snapshot = new VectorSnapshot({ vectorBytes: 64 })
 * snapshot.add('01JABCDEFGHJKLMN', quantizeToBinary(embedding))
 * const ids = snapshot.searchRough(quantizeToBinary(query), 5)
 * const file = snapshot.toBuffer() // upload to Drive / Bitable attachment
 * const restored = VectorSnapshot.fromBuffer(file)
 * ```
 */
export class VectorSnapshot {
  #idBytes: number
  #vectorBytes: number
  #vectorWords: number
  #dimensions: number
  #entryBytes: number
  #buffer: Buffer
  #words: Uint32Array | null
  #capacity: number
  #count = 0
  #index = new Map<string, number>()

  /**
   * @param options - Slot widths and initial capacity. `vectorBytes` must be a
   *   multiple of 4 so the scanner can compare whole 32-bit words.
   */
  constructor(options: VectorSnapshotOptions = {}) {
    const idBytes = options.idBytes ?? DEFAULT_ID_BYTES
    const vectorBytes = options.vectorBytes ?? DEFAULT_DIMENSIONS / 8
    const dimensions = vectorBytes * 8
    if (!Number.isInteger(idBytes) || idBytes < 1 || idBytes > 0xffff) {
      throw new RangeError('idBytes must be an integer between 1 and 65535')
    }
    if (!Number.isInteger(vectorBytes) || vectorBytes < 4 || vectorBytes > 0xffff) {
      throw new RangeError('vectorBytes must be an integer between 4 and 65535')
    }
    if (vectorBytes % 4 !== 0) {
      throw new RangeError('vectorBytes must be a multiple of 4 for aligned word scans')
    }
    const initialCapacity = options.initialCapacity ?? MIN_EXPANSION
    if (!Number.isInteger(initialCapacity) || initialCapacity < 1) {
      throw new RangeError('initialCapacity must be a positive integer')
    }

    this.#idBytes = idBytes
    this.#vectorBytes = vectorBytes
    this.#vectorWords = vectorBytes >>> 2
    this.#dimensions = dimensions
    this.#entryBytes = idBytes + vectorBytes
    this.#capacity = initialCapacity
    this.#buffer = Buffer.alloc(initialCapacity * this.#entryBytes)
    this.#words = (idBytes & 3) === 0 ? this.#newWordView(this.#buffer) : null
  }

  /** Number of stored vectors. */
  get size(): number {
    return this.#count
  }

  /** Number of slots before the next growth. */
  get capacity(): number {
    return this.#capacity
  }

  /** Fixed id slot width in bytes. */
  get idBytes(): number {
    return this.#idBytes
  }

  /** Packed vector width in bytes. */
  get vectorBytes(): number {
    return this.#vectorBytes
  }

  /** Original embedding dimensionality (`vectorBytes * 8`). */
  get dimensions(): number {
    return this.#dimensions
  }

  /** Rough memory footprint of the arena itself, excluding the id index. */
  get byteLength(): number {
    return this.#count * this.#entryBytes
  }

  /**
   * Insert a vector, or replace the vector of an existing id.
   *
   * The id index makes this O(1) and keeps duplicate ids out of the arena
   * even after thousands of incremental upserts.
   *
   * @param recordId - Logical id, UTF-8, at most `idBytes` bytes, no NUL.
   * @param vector - Packed sketch of exactly `vectorBytes` bytes.
   * @throws {RangeError} If the id or vector has the wrong shape.
   */
  add(recordId: string, vector: Uint8Array): void {
    this.#assertVectorShape(vector)
    assertRecordIdFits(recordId, this.#idBytes)

    const existing = this.#index.get(recordId)
    if (existing !== undefined) {
      this.#buffer.set(vector, existing * this.#entryBytes + this.#idBytes)
      return
    }

    if (this.#count === this.#capacity) this.#grow(this.#count + 1)
    const entryOffset = this.#count * this.#entryBytes
    // The slot comes from a zero-filled arena, so only the id bytes need to
    // be written; the remaining padding is already NUL.
    this.#buffer.write(recordId, entryOffset, this.#idBytes, 'utf8')
    this.#buffer.set(vector, entryOffset + this.#idBytes)
    this.#index.set(recordId, this.#count)
    this.#count++
  }

  /** Whether `recordId` is present. */
  has(recordId: string): boolean {
    return this.#index.has(recordId)
  }

  /** Remove all entries while keeping the allocated arena. */
  clear(): void {
    this.#count = 0
    this.#index.clear()
    this.#buffer.fill(0)
  }

  /**
   * Rough-rank the index and return the ids of the `topK` closest sketches.
   *
   * @param queryVector - Packed query sketch of exactly `vectorBytes` bytes.
   * @param topK - Maximum number of ids. Defaults to 5.
   * @returns Ids ordered by ascending Hamming distance (best first).
   */
  searchRough(queryVector: Uint8Array, topK = 5): string[] {
    return this.searchRoughDetailed(queryVector, topK).map((match) => match.recordId)
  }

  /**
   * Same as {@link searchRough} but also returns the Hamming distances, which
   * callers can surface as a coarse similarity score.
   *
   * The scan does not allocate per candidate: a fixed-size min-heap of "worst"
   * entries is kept in two typed arrays, and ids are decoded only for the at
   * most `topK` winners.
   */
  searchRoughDetailed(queryVector: Uint8Array, topK = 5): RoughMatch[] {
    this.#assertVectorShape(queryVector)
    if (!Number.isInteger(topK) || topK < 1) {
      throw new RangeError('topK must be a positive integer')
    }
    if (this.#count === 0) return []

    const limit = Math.min(topK, this.#count)
    const heapDistance = new Uint32Array(limit)
    const heapIndex = new Uint32Array(limit)
    let heapSize = 0

    const queryWords = toAlignedWords(queryVector)
    const entryBytes = this.#entryBytes
    const idBytes = this.#idBytes
    const vectorWords = this.#vectorWords
    const words = this.#words
    const scratch = words === null ? new Uint32Array(vectorWords) : null
    const scratchBytes = scratch === null ? null : new Uint8Array(scratch.buffer)

    for (let index = 0; index < this.#count; index++) {
      const entryOffset = index * entryBytes
      let distance = 0

      if (words !== null) {
        // Aligned arena: idBytes is a multiple of 4, therefore every vector
        // starts on a 32-bit boundary. Read straight from the arena.
        const vectorOffset = (entryOffset + idBytes) >>> 2
        for (let word = 0; word < vectorWords; word++) {
          distance += popcount32(words[vectorOffset + word]! ^ queryWords[word]!)
        }
      } else {
        // Unusual id width: stage the 64 bytes in an aligned scratch word
        // buffer before comparing. Still no strings and no float math.
        scratchBytes!.set(
          this.#buffer.subarray(entryOffset + idBytes, entryOffset + idBytes + this.#vectorBytes),
        )
        for (let word = 0; word < vectorWords; word++) {
          distance += popcount32(scratch![word]! ^ queryWords[word]!)
        }
      }

      if (heapSize < limit) {
        let slot = heapSize++
        heapDistance[slot] = distance
        heapIndex[slot] = index
        while (slot > 0) {
          const parent = (slot - 1) >>> 1
          if (
            !isWorse(
              heapDistance[slot]!,
              heapIndex[slot]!,
              heapDistance[parent]!,
              heapIndex[parent]!,
            )
          ) {
            break
          }
          const distanceSwap = heapDistance[slot]!
          const indexSwap = heapIndex[slot]!
          heapDistance[slot] = heapDistance[parent]!
          heapIndex[slot] = heapIndex[parent]!
          heapDistance[parent] = distanceSwap
          heapIndex[parent] = indexSwap
          slot = parent
        }
        continue
      }

      // Root is the worst of the current winners. Skip candidates that are
      // worse than the root; equal distances are broken by the lower arena
      // index, which makes results deterministic.
      if (isWorse(distance, index, heapDistance[0]!, heapIndex[0]!)) continue
      heapDistance[0] = distance
      heapIndex[0] = index
      let slot = 0
      for (;;) {
        const left = slot * 2 + 1
        if (left >= heapSize) break
        const right = left + 1
        let worst = left
        if (
          right < heapSize &&
          isWorse(heapDistance[right]!, heapIndex[right]!, heapDistance[left]!, heapIndex[left]!)
        ) {
          worst = right
        }
        if (
          !isWorse(
            heapDistance[worst]!,
            heapIndex[worst]!,
            heapDistance[slot]!,
            heapIndex[slot]!,
          )
        ) {
          break
        }
        const distanceSwap = heapDistance[slot]!
        const indexSwap = heapIndex[slot]!
        heapDistance[slot] = heapDistance[worst]!
        heapIndex[slot] = heapIndex[worst]!
        heapDistance[worst] = distanceSwap
        heapIndex[worst] = indexSwap
        slot = worst
      }
    }

    const order: Array<{ index: number; distance: number }> = []
    for (let slot = 0; slot < heapSize; slot++) {
      order.push({ index: heapIndex[slot]!, distance: heapDistance[slot]! })
    }
    order.sort((a, b) => a.distance - b.distance || a.index - b.index)
    return order.map((entry) => ({
      recordId: this.#readId(entry.index),
      distance: entry.distance,
    }))
  }

  /** Id stored at arena position `index`. */
  idAt(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= this.#count) {
      throw new RangeError(`idAt: index ${index} is out of range [0, ${this.#count})`)
    }
    return this.#readId(index)
  }

  /**
   * Copy of the packed vector for `recordId`, or `null` when absent.
   * Returning a copy keeps the arena immutable from the caller's perspective.
   */
  getVector(recordId: string): Uint8Array | null {
    const index = this.#index.get(recordId)
    if (index === undefined) return null
    const offset = index * this.#entryBytes + this.#idBytes
    return new Uint8Array(this.#buffer.subarray(offset, offset + this.#vectorBytes))
  }

  /**
   * Serialize the index into a single self-describing buffer.
   *
   * Header (little-endian): magic `LFVS`, version, header size, id/vector
   * widths, dimensions, count, FNV-1a checksum of the entry payload. The
   * arena follows verbatim, so loading needs no parsing of individual rows.
   * Upload the result to Feishu Drive or store it as a Bitable attachment.
   */
  toBuffer(): Buffer {
    const payloadBytes = this.#count * this.#entryBytes
    const output = Buffer.alloc(HEADER_BYTES + payloadBytes)
    output.write(MAGIC, OFF_MAGIC, 'ascii')
    output.writeUInt16LE(VERSION, OFF_VERSION)
    output.writeUInt16LE(HEADER_BYTES, OFF_HEADER_BYTES)
    output.writeUInt16LE(this.#idBytes, OFF_ID_BYTES)
    output.writeUInt16LE(this.#vectorBytes, OFF_VECTOR_BYTES)
    output.writeUInt32LE(this.#dimensions, OFF_DIMENSIONS)
    output.writeUInt32LE(this.#count, OFF_COUNT)
    if (payloadBytes > 0) {
      output.set(this.#buffer.subarray(0, payloadBytes), HEADER_BYTES)
    }
    output.writeUInt32LE(
      fnv1a32(output, HEADER_BYTES, HEADER_BYTES + payloadBytes),
      OFF_CHECKSUM,
    )
    return output
  }

  /**
   * Deserialize and validate a buffer produced by {@link toBuffer}.
   *
   * @throws {TypeError} If the input is not a byte buffer.
   * @throws {RangeError} On a bad magic, unsupported version, inconsistent
   *   header, truncated payload, checksum mismatch or corrupt ids.
   */
  static fromBuffer(input: Buffer | Uint8Array): VectorSnapshot {
    if (!(input instanceof Uint8Array)) {
      throw new TypeError('VectorSnapshot.fromBuffer expects a Buffer or Uint8Array')
    }
    // Buffer is a Uint8Array subclass, but the numeric readers live on Buffer.
    // Reuse the same memory when possible instead of copying the whole file.
    const buffer = Buffer.isBuffer(input)
      ? input
      : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    if (buffer.length < HEADER_BYTES) {
      throw new RangeError(`snapshot is too short: ${buffer.length} < ${HEADER_BYTES} header bytes`)
    }
    const magic = buffer.toString('ascii', OFF_MAGIC, OFF_MAGIC + MAGIC.length)
    if (magic !== MAGIC && magic !== LEGACY_MAGIC) {
      throw new RangeError('snapshot has an invalid magic header')
    }
    const version = buffer.readUInt16LE(OFF_VERSION)
    if (version !== VERSION) {
      throw new RangeError(`unsupported snapshot version ${version}; this build understands ${VERSION}`)
    }
    const headerBytes = buffer.readUInt16LE(OFF_HEADER_BYTES)
    if (headerBytes < HEADER_BYTES || headerBytes > buffer.length) {
      throw new RangeError(`snapshot header size ${headerBytes} is invalid`)
    }
    const idBytes = buffer.readUInt16LE(OFF_ID_BYTES)
    const vectorBytes = buffer.readUInt16LE(OFF_VECTOR_BYTES)
    const dimensions = buffer.readUInt32LE(OFF_DIMENSIONS)
    const count = buffer.readUInt32LE(OFF_COUNT)
    const checksum = buffer.readUInt32LE(OFF_CHECKSUM)

    if (idBytes < 1 || vectorBytes < 4 || vectorBytes % 4 !== 0) {
      throw new RangeError(`snapshot slot sizes are invalid (id=${idBytes}, vector=${vectorBytes})`)
    }
    if (dimensions !== vectorBytes * 8) {
      throw new RangeError(
        `snapshot dimensions ${dimensions} do not match vectorBytes ${vectorBytes} * 8`,
      )
    }
    const entryBytes = idBytes + vectorBytes
    const payloadBytes = buffer.length - headerBytes
    if (payloadBytes !== count * entryBytes) {
      throw new RangeError(
        `snapshot payload is ${payloadBytes} bytes; expected ${count} entries of ${entryBytes} bytes`,
      )
    }
    if (fnv1a32(buffer, headerBytes, buffer.length) !== checksum) {
      throw new RangeError('snapshot checksum mismatch (file is corrupted or truncated)')
    }

    const snapshot = new VectorSnapshot({
      idBytes,
      vectorBytes,
      initialCapacity: Math.max(count, 1),
    })
    if (payloadBytes > 0) {
      snapshot.#buffer.set(buffer.subarray(headerBytes, buffer.length), 0)
    }
    snapshot.#count = count
    for (let index = 0; index < count; index++) {
      const entryOffset = index * entryBytes
      const recordId = snapshot.#readId(index)
      if (recordId.length === 0) {
        throw new RangeError(`snapshot entry ${index} has an empty record id`)
      }
      if (recordId.includes('\0')) {
        throw new RangeError(`snapshot entry ${index} has an invalid record id`)
      }
      if (snapshot.#index.has(recordId)) {
        throw new RangeError(`snapshot contains duplicate record id "${recordId}"`)
      }
      // The id must occupy a well-formed prefix of its slot; anything after it
      // has to be NUL padding. This rejects silently corrupted id arenas.
      const written = Buffer.byteLength(recordId, 'utf8')
      for (let byte = written; byte < idBytes; byte++) {
        if (snapshot.#buffer[entryOffset + byte] !== 0) {
          throw new RangeError(`snapshot entry ${index} has a malformed record id slot`)
        }
      }
      snapshot.#index.set(recordId, index)
    }
    return snapshot
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #newWordView(buffer: Buffer): Uint32Array {
    return new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength >>> 2)
  }

  #grow(minimum: number): void {
    let capacity = this.#capacity
    while (capacity < minimum) {
      if (capacity > 0x3fffffff / this.#entryBytes) {
        throw new RangeError('VectorSnapshot cannot grow beyond the maximum ArrayBuffer size')
      }
      capacity *= 2
    }
    const nextBuffer = Buffer.alloc(capacity * this.#entryBytes)
    this.#buffer.copy(nextBuffer, 0, 0, this.#count * this.#entryBytes)
    this.#buffer = nextBuffer
    this.#capacity = capacity
    this.#words = (this.#idBytes & 3) === 0 ? this.#newWordView(nextBuffer) : null
  }

  #assertVectorShape(vector: Uint8Array): void {
    if (!(vector instanceof Uint8Array)) {
      throw new TypeError('vector must be a Uint8Array')
    }
    if (vector.length !== this.#vectorBytes) {
      throw new RangeError(
        `vector must be ${this.#vectorBytes} bytes (${this.#dimensions} dimensions); got ${vector.length}`,
      )
    }
  }

  #readId(index: number): string {
    const start = index * this.#entryBytes
    let end = start + this.#idBytes
    while (end > start && this.#buffer[end - 1] === 0) end--
    return this.#buffer.toString('utf8', start, end)
  }
}
