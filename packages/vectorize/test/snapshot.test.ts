import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hammingDistance } from '../src/math.js'
import { VectorSnapshot } from '../src/snapshot.js'

const VECTOR_BYTES = 64

/** Build a 512-bit sketch with the listed bit positions set. */
function sketch(ones: number[] = []): Uint8Array {
  const bytes = new Uint8Array(VECTOR_BYTES)
  for (const index of ones) {
    bytes[index >>> 3] = bytes[index >>> 3]! | (1 << (index & 7))
  }
  return bytes
}

test('add / searchRough ranks by Hamming distance', () => {
  const snapshot = new VectorSnapshot()
  snapshot.add('chunk-d', sketch([0, 1, 2, 3, 4, 5, 6, 7]))
  snapshot.add('chunk-c', sketch([0, 1, 2, 3]))
  snapshot.add('chunk-b', sketch(Array.from({ length: 64 }, (_, i) => i)))
  snapshot.add('chunk-a', sketch(Array.from({ length: 512 }, (_, i) => i)))

  const query = sketch([0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(snapshot.searchRough(query, 1), ['chunk-d'])
  assert.deepEqual(snapshot.searchRough(query, 5), ['chunk-d', 'chunk-c', 'chunk-b', 'chunk-a'])

  const detailed = snapshot.searchRoughDetailed(query, 2)
  assert.deepEqual(detailed, [
    { recordId: 'chunk-d', distance: 0 },
    { recordId: 'chunk-c', distance: 4 },
  ])
  assert.equal(snapshot.size, 4)
  assert.equal(snapshot.dimensions, 512)
  assert.equal(snapshot.vectorBytes, 64)
  assert.equal(snapshot.idBytes, 16)
  assert.ok(snapshot.byteLength >= 4 * 80)
})

test('searchRough is deterministic on ties and preserves insertion order', () => {
  const snapshot = new VectorSnapshot()
  const vector = sketch([10, 20, 30])
  snapshot.add('first', vector)
  snapshot.add('second', vector)
  snapshot.add('third', vector)
  assert.deepEqual(snapshot.searchRough(vector, 1), ['first'])
  assert.deepEqual(snapshot.searchRough(vector, 3), ['first', 'second', 'third'])
})

test('adding an existing id replaces its vector without growing the arena', () => {
  const snapshot = new VectorSnapshot()
  snapshot.add('same', sketch(Array.from({ length: 32 }, (_, i) => i)))
  const before = snapshot.byteLength
  snapshot.add('same', sketch([0]))
  assert.equal(snapshot.size, 1)
  assert.equal(snapshot.byteLength, before)
  assert.equal(hammingDistance(snapshot.getVector('same')!, sketch([0])), 0)
  assert.equal(snapshot.searchRoughDetailed(sketch([0]), 1)[0]!.distance, 0)
  assert.equal(snapshot.has('same'), true)
  assert.equal(snapshot.getVector('missing'), null)
})

test('the arena grows geometrically and keeps every entry', () => {
  const snapshot = new VectorSnapshot({ initialCapacity: 1 })
  for (let i = 0; i < 100; i++) {
    snapshot.add(`id-${String(i).padStart(3, '0')}`, sketch([i]))
  }
  assert.equal(snapshot.size, 100)
  assert.ok(snapshot.capacity >= 100)
  const hits = snapshot.searchRoughDetailed(sketch([42]), 100)
  assert.equal(hits.length, 100)
  assert.equal(hits[0]!.recordId, 'id-042')
  assert.equal(hits[0]!.distance, 0)
  assert.equal(snapshot.idAt(42), 'id-042')
  assert.throws(() => snapshot.idAt(-1), /out of range/)
  assert.throws(() => snapshot.idAt(100), /out of range/)
})

test('Top-K selection matches a brute-force sort on random sketches', () => {
  let state = 0x12345678
  const randomByte = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state >>> 24
  }

  const snapshot = new VectorSnapshot({ vectorBytes: 8 })
  const vectors: Uint8Array[] = []
  for (let index = 0; index < 500; index++) {
    const vector = new Uint8Array(8)
    for (let byte = 0; byte < vector.length; byte++) vector[byte] = randomByte()
    vectors.push(vector)
    snapshot.add(`id-${String(index).padStart(3, '0')}`, vector)
  }
  const query = new Uint8Array(8)
  for (let byte = 0; byte < query.length; byte++) query[byte] = randomByte()

  const ranked = vectors
    .map((vector, index) => ({ index, distance: hammingDistance(query, vector) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)

  for (const topK of [1, 5, 10, 50, 499, 500, 900]) {
    const expected = ranked.slice(0, topK).map((entry) => ({
      recordId: `id-${String(entry.index).padStart(3, '0')}`,
      distance: entry.distance,
    }))
    assert.deepEqual(snapshot.searchRoughDetailed(query, topK), expected)
  }
})

test('serialization round-trips ids, vectors, order and search results', () => {
  const snapshot = new VectorSnapshot({ initialCapacity: 4 })
  for (let i = 0; i < 300; i++) {
    const ones: number[] = []
    for (let bit = 0; bit < 512; bit += 7) if ((bit + i) % 3 === 0) ones.push(bit)
    snapshot.add(`chunk-${String(i).padStart(4, '0')}`, sketch(ones))
  }

  const file = snapshot.toBuffer()
  assert.ok(Buffer.isBuffer(file))
  assert.equal(file.subarray(0, 4).toString('ascii'), 'LFVS')
  assert.equal(file.length, 32 + 300 * 80)

  // Snapshots written before the Larkflare rename still load.
  const legacy = Buffer.from(file)
  legacy.write('LKVS', 0, 'ascii')
  assert.equal(VectorSnapshot.fromBuffer(legacy).size, 300)

  const restored = VectorSnapshot.fromBuffer(file)
  assert.equal(restored.size, 300)
  assert.equal(restored.dimensions, 512)
  assert.equal(restored.vectorBytes, 64)
  assert.equal(restored.idBytes, 16)
  assert.equal(restored.idAt(123), 'chunk-0123')
  assert.equal(
    hammingDistance(restored.getVector('chunk-0123')!, snapshot.getVector('chunk-0123')!),
    0,
  )

  const query = sketch([1, 2, 3, 4, 5])
  assert.deepEqual(restored.searchRoughDetailed(query, 10), snapshot.searchRoughDetailed(query, 10))

  // Any Uint8Array view is accepted, even one with a non-zero byteOffset.
  const padded = Buffer.alloc(file.length + 4)
  file.copy(padded, 4)
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 4, file.length)
  assert.deepEqual(VectorSnapshot.fromBuffer(view).searchRough(query, 3), restored.searchRough(query, 3))
})

test('an empty snapshot round-trips', () => {
  const snapshot = new VectorSnapshot()
  const restored = VectorSnapshot.fromBuffer(snapshot.toBuffer())
  assert.equal(restored.size, 0)
  assert.deepEqual(restored.searchRough(new Uint8Array(VECTOR_BYTES), 5), [])
})

test('fromBuffer rejects corrupt, truncated and incompatible files', () => {
  const snapshot = new VectorSnapshot()
  snapshot.add('chunk-1', sketch([1, 2, 3]))
  snapshot.add('chunk-2', sketch([4, 5, 6]))
  const good = snapshot.toBuffer()

  const badMagic = Buffer.from(good)
  badMagic.write('XXXX', 0, 'ascii')
  assert.throws(() => VectorSnapshot.fromBuffer(badMagic), /magic/)

  const badVersion = Buffer.from(good)
  badVersion.writeUInt16LE(99, 4)
  assert.throws(() => VectorSnapshot.fromBuffer(badVersion), /unsupported snapshot version/)

  const badChecksum = Buffer.from(good)
  badChecksum[badChecksum.length - 1] = badChecksum[badChecksum.length - 1]! ^ 0xff
  assert.throws(() => VectorSnapshot.fromBuffer(badChecksum), /checksum mismatch/)

  assert.throws(() => VectorSnapshot.fromBuffer(good.subarray(0, good.length - 1)), /payload/)
  assert.throws(() => VectorSnapshot.fromBuffer(Buffer.alloc(8)), /too short/)
  assert.throws(
    () => VectorSnapshot.fromBuffer('LFVS' as unknown as Buffer),
    /Buffer or Uint8Array/,
  )
})

test('record ids and vectors are validated before touching the arena', () => {
  const snapshot = new VectorSnapshot()
  assert.throws(() => snapshot.add('', sketch()), /non-empty string/)
  assert.throws(() => snapshot.add('x'.repeat(17), sketch()), /17 bytes/)
  assert.throws(() => snapshot.add('a\0b', sketch()), /NUL/)
  assert.throws(() => snapshot.add('ok', new Uint8Array(63)), /must be 64 bytes/)
  assert.throws(() => snapshot.add('ok', [0] as unknown as Uint8Array), /Uint8Array/)
  assert.equal(snapshot.size, 0)
  assert.throws(() => new VectorSnapshot({ vectorBytes: 63 }), /multiple of 4/)
  assert.throws(() => new VectorSnapshot({ idBytes: 0 }), /idBytes/)
  assert.throws(() => new VectorSnapshot({ initialCapacity: 0 }), /initialCapacity/)
})

test('non-word-aligned id slots still scan correctly', () => {
  // idBytes = 5 forces the unaligned scratch path; vectorBytes = 4 keeps the
  // test focused while still exercising real word comparisons.
  const snapshot = new VectorSnapshot({ idBytes: 5, vectorBytes: 4 })
  const vectors: Uint8Array[] = []
  for (let i = 0; i < 20; i++) {
    const vector = new Uint8Array([i, i + 1, i + 2, i + 3])
    vectors.push(vector)
    snapshot.add(`id${i}`, vector)
  }
  const query = new Uint8Array([5, 5, 5, 5])
  const hits = snapshot.searchRoughDetailed(query, 20)
  assert.equal(hits.length, 20)
  const expected = vectors
    .map((vector, index) => ({ index, distance: hammingDistance(query, vector) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map((entry) => ({ recordId: `id${entry.index}`, distance: entry.distance }))
  assert.deepEqual(hits, expected)

  const restored = VectorSnapshot.fromBuffer(snapshot.toBuffer())
  assert.equal(restored.idBytes, 5)
  assert.deepEqual(restored.searchRoughDetailed(query, 20), expected)
})

test('search validates topK and query shape; clear resets the index', () => {
  const snapshot = new VectorSnapshot()
  snapshot.add('only', sketch([0]))
  assert.throws(() => snapshot.searchRough(sketch(), 0), /topK/)
  assert.throws(() => snapshot.searchRough(new Uint8Array(63), 1), /must be 64 bytes/)
  assert.deepEqual(snapshot.searchRough(sketch([0]), 10), ['only'])
  snapshot.clear()
  assert.equal(snapshot.size, 0)
  assert.deepEqual(snapshot.searchRough(sketch([0]), 10), [])
})
