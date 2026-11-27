/**
 * Bit-level vector math.
 *
 * Everything here is designed for the hot path of a 1-bit vector search:
 * no strings, no per-element allocations, and only 32-bit integer operations.
 * A 512-dimensional sketch is 64 bytes, so one Hamming distance costs 16 XORs
 * and 16 popcounts.
 */

/** Number of bits in one packed byte. */
const BITS_PER_BYTE = 8

/**
 * Pack a float embedding into a 1-bit sketch.
 *
 * Bit `i` of dimension `i` is set when `vector[i] > 0`; values `<= 0` (and
 * negative zero) become `0`. Bits are packed least-significant-bit first:
 * dimension 0 is bit 0 of byte 0, dimension 8 is bit 0 of byte 1, and so on.
 * For the default 512 dimensions the result is exactly 64 bytes.
 *
 * @param vector - Embedding values. Length is the dimensionality; a length
 *   that is not a multiple of 8 is allowed and pads the last byte with zeros.
 * @returns Packed sketch of `ceil(vector.length / 8)` bytes.
 * @throws {TypeError} If the vector is empty or contains `NaN` / `Infinity`.
 */
export function quantizeToBinary(vector: ArrayLike<number>): Uint8Array {
  if (vector === null || vector === undefined || typeof vector.length !== 'number') {
    throw new TypeError('quantizeToBinary expects an array-like of numbers')
  }
  const length = vector.length
  if (length === 0) throw new TypeError('quantizeToBinary requires a non-empty vector')

  const packed = new Uint8Array((length + BITS_PER_BYTE - 1) >>> 3)
  for (let i = 0; i < length; i++) {
    const value = vector[i]!
    if (!Number.isFinite(value)) {
      throw new TypeError(`quantizeToBinary: vector[${i}] must be a finite number`)
    }
    if (value > 0) {
      const byteIndex = i >>> 3
      packed[byteIndex] = packed[byteIndex]! | (1 << (i & 7))
    }
  }
  return packed
}

/**
 * Population count of a 32-bit integer (SWAR, no lookup table).
 *
 * This is the classic Hacker's Delight sequence. It stays inside 32-bit
 * integer arithmetic (`Math.imul` for the final multiply), so V8 keeps it in
 * machine-word registers without boxing.
 *
 * @param value - Any 32-bit integer (the sign is irrelevant).
 * @returns Number of set bits, `0..32`.
 */
export function popcount32(value: number): number {
  let x = value
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return Math.imul(x, 0x01010101) >>> 24
}

/**
 * Hamming distance between two packed sketches, in bits.
 *
 * Uses `Uint32Array` views when both buffers are 4-byte aligned (Buffer views
 * of a 64-byte sketch normally are), which turns 64 byte comparisons into 16
 * word XOR/popcount pairs. Unaligned inputs fall back to byte-wise popcounts,
 * never to strings and never to floating-point math.
 *
 * @param a - First packed sketch.
 * @param b - Second packed sketch; must have the same byte length as `a`.
 * @returns Number of differing bits, `0..a.length * 8`.
 * @throws {TypeError} If either argument is not a `Uint8Array`.
 * @throws {RangeError} If the lengths differ.
 */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
    throw new TypeError('hammingDistance expects two Uint8Array values')
  }
  if (a.length !== b.length) {
    throw new RangeError(
      `hammingDistance requires equal lengths (got ${a.length} and ${b.length} bytes)`,
    )
  }
  if (a.length === 0) return 0

  let distance = 0
  let offset = 0

  // Fast path: both views start on a 32-bit boundary. This is the common case
  // for freshly allocated Uint8Arrays and for vectors copied out of the
  // snapshot arena.
  if ((a.byteOffset & 3) === 0 && (b.byteOffset & 3) === 0) {
    const words = a.length >>> 2
    if (words > 0) {
      const a32 = new Uint32Array(a.buffer, a.byteOffset, words)
      const b32 = new Uint32Array(b.buffer, b.byteOffset, words)
      for (let i = 0; i < words; i++) {
        distance += popcount32(a32[i]! ^ b32[i]!)
      }
      offset = words << 2
    }
  }

  // Tail (or the whole vector when unaligned). A single byte XOR has at most
  // eight bits, so the 32-bit SWAR routine is still the cheapest option.
  for (; offset < a.length; offset++) {
    distance += popcount32(a[offset]! ^ b[offset]!)
  }
  return distance
}

/**
 * Copy a sketch into a fresh, 4-byte-aligned `Uint32Array`.
 *
 * The snapshot scanner compares a query against many stored vectors, so it
 * wants the query in word form. Copying once per search is cheaper than
 * dealing with unaligned query views for every candidate.
 *
 * @internal
 */
export function toAlignedWords(vector: Uint8Array): Uint32Array {
  if ((vector.byteOffset & 3) === 0) {
    const words = vector.length >>> 2
    if (words > 0 && vector.length === words << 2) {
      return new Uint32Array(vector.buffer, vector.byteOffset, words)
    }
  }
  const copy = new Uint8Array((vector.length + 3) & ~3)
  copy.set(vector)
  return new Uint32Array(copy.buffer, 0, copy.length >>> 2)
}
