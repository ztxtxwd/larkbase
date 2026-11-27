import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { hammingDistance, popcount32, quantizeToBinary } from '../src/math.js'

test('quantizeToBinary packs sign bits least-significant-bit first', () => {
  const alternating = quantizeToBinary([1, -1, 1, -1, 1, -1, 1, -1])
  assert.equal(alternating.length, 1)
  assert.equal(alternating[0], 0b01010101)

  const nonPositive = quantizeToBinary([0, -0, -1, -0.5, Number.MIN_VALUE * -1])
  assert.equal(nonPositive.length, 1)
  assert.equal(nonPositive[0], 0)

  const padded = quantizeToBinary([1])
  assert.equal(padded.length, 1)
  assert.equal(padded[0], 0b00000001)
})

test('quantizeToBinary produces the canonical 64-byte 512-d sketch', () => {
  const vector = Array.from({ length: 512 }, (_, index) => (index % 2 === 0 ? 0.25 : -0.25))
  const sketch = quantizeToBinary(vector)
  assert.equal(sketch.length, 64)
  for (const byte of sketch) assert.equal(byte, 0x55)
})

test('quantizeToBinary rejects empty and non-finite vectors', () => {
  assert.throws(() => quantizeToBinary([]), /non-empty/)
  assert.throws(() => quantizeToBinary([1, Number.NaN, -1]), /finite/)
  assert.throws(() => quantizeToBinary([1, Number.POSITIVE_INFINITY]), /finite/)
  assert.throws(() => quantizeToBinary(null as unknown as number[]), /array-like/)
})

test('popcount32 matches the bit definition', () => {
  assert.equal(popcount32(0), 0)
  assert.equal(popcount32(1), 1)
  assert.equal(popcount32(0x80000000 | 0), 1)
  assert.equal(popcount32(0x55555555), 16)
  assert.equal(popcount32(0xffffffff | 0), 32)
  let expected = 0
  for (let value = 0; value < 1024; value++) {
    expected = value.toString(2).split('1').length - 1
    assert.equal(popcount32(value), expected)
  }
})

test('hammingDistance handles identical, inverted and unaligned sketches', () => {
  const zero = new Uint8Array(64)
  const ones = new Uint8Array(64).fill(0xff)
  assert.equal(hammingDistance(zero, zero), 0)
  assert.equal(hammingDistance(zero, ones), 512)
  assert.equal(hammingDistance(ones, ones), 0)

  assert.equal(hammingDistance(new Uint8Array([0b10101010]), new Uint8Array([0b01010101])), 8)
  assert.equal(hammingDistance(new Uint8Array(0), new Uint8Array(0)), 0)

  // Offset views force the byte-wise fallback path.
  const backingA = new Uint8Array(65)
  const backingB = new Uint8Array(65)
  for (let i = 0; i < 64; i++) {
    backingA[i + 1] = i % 3 === 0 ? 0xff : 0x0f
    backingB[i + 1] = i % 5 === 0 ? 0xaa : 0x00
  }
  const unaligned = hammingDistance(backingA.subarray(1, 65), backingB.subarray(1, 65))
  let expected = 0
  for (let i = 0; i < 64; i++) {
    expected += popcount32(backingA[i + 1]! ^ backingB[i + 1]!)
  }
  assert.equal(unaligned, expected)
})

test('hammingDistance agrees with a naive bit loop on random data', () => {
  for (let round = 0; round < 50; round++) {
    const a = new Uint8Array(randomBytes(64))
    const b = new Uint8Array(randomBytes(64))
    let naive = 0
    for (let i = 0; i < 64; i++) {
      let xor = a[i]! ^ b[i]!
      while (xor !== 0) {
        naive += xor & 1
        xor >>>= 1
      }
    }
    assert.equal(hammingDistance(a, b), naive)
  }
})

test('hammingDistance validates its inputs', () => {
  assert.throws(() => hammingDistance([0] as unknown as Uint8Array, new Uint8Array(1)), /Uint8Array/)
  assert.throws(
    () => hammingDistance(new Uint8Array(4), new Uint8Array(8)),
    /equal lengths/,
  )
})
