/**
 * Rough-rank micro-benchmark.
 *
 *   pnpm --filter @larkbase/vector bench            # 200k vectors
 *   pnpm --filter @larkbase/vector bench -- 1000000 # 1M vectors
 *
 * Measures the two costs that dominate the in-memory stage: packing float
 * embeddings into 64-byte sketches, and scanning the arena for Top-K.
 */
import { performance } from 'node:perf_hooks'
import { quantizeToBinary } from '../src/math.js'
import { VectorSnapshot } from '../src/snapshot.js'

const COUNT = Number(process.argv[2] ?? 200_000)
const DIMENSIONS = 512
const QUERIES = 200
const TOP_K = 10

if (!Number.isInteger(COUNT) || COUNT <= 0) {
  throw new Error('usage: tsx bench/perf.ts [positive-vector-count]')
}

/** Deterministic xorshift32 so runs are comparable. */
let state = 0x9e3779b9
function random(): number {
  state ^= state << 13
  state ^= state >>> 17
  state ^= state << 5
  return (state >>> 0) / 0x1_0000_0000
}

const embedding = new Float32Array(DIMENSIONS)
const snapshot = new VectorSnapshot({ initialCapacity: Math.max(64, COUNT) })

const ingestStart = performance.now()
for (let index = 0; index < COUNT; index++) {
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
    embedding[dimension] = random() * 2 - 1
  }
  snapshot.add(`chunk-${String(index).padStart(10, '0')}`, quantizeToBinary(embedding))
}
const ingestMs = performance.now() - ingestStart

const query = new Float32Array(DIMENSIONS)
const querySketches: Uint8Array[] = []
for (let index = 0; index < QUERIES; index++) {
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
    query[dimension] = random() * 2 - 1
  }
  querySketches.push(quantizeToBinary(query))
}

const searchStart = performance.now()
let checksum = 0
for (const sketch of querySketches) {
  const hits = snapshot.searchRoughDetailed(sketch, TOP_K)
  checksum += hits[0]?.distance ?? 0
}
const searchMs = performance.now() - searchStart

const quantizeRounds = 5_000
const quantizeStart = performance.now()
for (let index = 0; index < quantizeRounds; index++) {
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
    query[dimension] = random() * 2 - 1
  }
  quantizeToBinary(query)
}
const quantizeMs = performance.now() - quantizeStart

const format = (value: number): string =>
  value >= 1000 ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : value.toFixed(1)

console.log(`vectors            ${format(COUNT)} x ${DIMENSIONS}d (${snapshot.vectorBytes} B/sketch)`)
console.log(`arena              ${(snapshot.byteLength / 1024 / 1024).toFixed(1)} MiB`)
console.log(`ingest             ${format(ingestMs)} ms  (${format((COUNT / ingestMs) * 1000)} vectors/s, includes quantization)`)
console.log(
  `search             ${format(searchMs)} ms for ${QUERIES} queries  ` +
    `(${format((QUERIES / searchMs) * 1000)} qps, ` +
    `${((searchMs * 1_000_000) / (QUERIES * COUNT)).toFixed(1)} ns/vector)`,
)
console.log(`quantize           ${format(quantizeMs)} ms for ${format(quantizeRounds)} vectors  (${format((quantizeRounds / quantizeMs) * 1000)} vectors/s)`)
console.log(`top-${TOP_K} checksum     ${checksum}`)
