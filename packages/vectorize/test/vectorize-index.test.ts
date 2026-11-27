import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Database, Table, UpdateSpec, WithId } from '@larkflare/db'
import {
  VectorizeIndex,
  VECTOR_TABLE_SCHEMA,
  createRecordId,
} from '../src/VectorizeIndex.js'
import type {
  CompositeChunk,
  VectorRecord,
  VectorTable,
} from '../src/types.js'

const DIMENSIONS = 512

/** 512-d embedding: +1 for positions accepted by `positive`, -1 otherwise. */
function embedding(positive: (index: number) => boolean): number[] {
  return Array.from({ length: DIMENSIONS }, (_, index) => (positive(index) ? 1 : -1))
}

function chunk(id: string, text: string): CompositeChunk {
  return {
    id,
    source: { doc_token: 'doxcn-source', block_id: 'blk-source' },
    media: [{ file_token: 'boxcn-asset', type: 'image', caption: 'architecture' }],
    context_text: text,
    metadata: { lang: 'zh', confidence: 0.9 },
  }
}

/** In-memory stand-in for a Larkflare table. */
class MemoryTable implements VectorTable<VectorRecord> {
  readonly rows = new Map<string, WithId<VectorRecord>>()
  inserts = 0
  updates = 0

  async insertOne(doc: VectorRecord): Promise<WithId<VectorRecord>> {
    if (!doc._id) throw new Error('test table requires an _id')
    if (this.rows.has(doc._id)) throw new Error(`duplicate _id ${doc._id}`)
    const row = { ...doc, _id: doc._id } as WithId<VectorRecord>
    this.rows.set(row._id, row)
    this.inserts++
    return row
  }

  async updateById(
    id: string,
    update: UpdateSpec<VectorRecord>,
  ): Promise<{ matchedCount: number }> {
    const row = this.rows.get(id)
    if (!row) return { matchedCount: 0 }
    this.rows.set(id, { ...row, ...(update as Partial<VectorRecord>), _id: id })
    this.updates++
    return { matchedCount: 1 }
  }

  async batchGet(ids: string[]): Promise<Array<WithId<VectorRecord> | null>> {
    return ids.map((id) => this.rows.get(id) ?? null)
  }
}

// Compile-time proof that the real DB Table satisfies the adapter contract.
type AssertAssignable<A extends B, B> = A
type DbTableFits = AssertAssignable<Table<VectorRecord>, VectorTable<VectorRecord>>
const dbTableFits: DbTableFits | null = null
void dbTableFits

// Compile-time proof of the documented integration path. Never executed.
function compileOnlyWiring(database: Database): VectorizeIndex {
  const table = database.defineTable<VectorRecord>('chunks', VECTOR_TABLE_SCHEMA)
  return new VectorizeIndex(table)
}
void compileOnlyWiring

test('the exported schema describes every stored field', () => {
  assert.deepEqual(Object.keys(VECTOR_TABLE_SCHEMA).sort(), [
    'context_text',
    'dimensions',
    'media',
    'metadata',
    'source',
    'updated_at',
    'vector_b64',
  ])
  assert.equal(VECTOR_TABLE_SCHEMA.vector_b64, 'text')
  assert.equal(VECTOR_TABLE_SCHEMA.dimensions, 'number')
})

test('upsert inserts, then updates, and keeps one Bitable row per chunk', async () => {
  const table = new MemoryTable()
  const db = new VectorizeIndex(table)

  const first = await db.upsert(
    chunk('chunk-1', 'version one'),
    embedding((index) => index < 256),
  )
  assert.deepEqual(first, {
    recordId: 'chunk-1',
    created: true,
    dimensions: 512,
    vectorBytes: 64,
  })
  assert.equal(table.inserts, 1)
  assert.equal(table.rows.size, 1)

  const stored = table.rows.get('chunk-1')!
  assert.equal(stored.context_text, 'version one')
  assert.equal(stored.metadata.lang, 'zh')
  assert.equal(stored.dimensions, 512)
  assert.equal(Buffer.from(stored.vector_b64, 'base64').length, 64)

  const second = await db.upsert(
    chunk('chunk-1', 'version two'),
    embedding((index) => index < 128),
  )
  assert.equal(second.created, false)
  assert.equal(table.inserts, 1)
  assert.equal(table.updates, 1)
  assert.equal(table.rows.size, 1)
  assert.equal(table.rows.get('chunk-1')!.context_text, 'version two')
  assert.equal(db.size, 1)
})

test('search rough-ranks in memory, then fetches full chunks in order', async () => {
  const table = new MemoryTable()
  const db = new VectorizeIndex(table)

  await db.upsert(chunk('chunk-a', 'exact'), embedding((index) => index < 256))
  await db.upsert(chunk('chunk-b', 'half'), embedding((index) => index < 128))
  await db.upsert(chunk('chunk-c', 'quarter'), embedding((index) => index < 64))

  const query = embedding((index) => index < 256)
  const matches = await db.search(query, 3)
  assert.deepEqual(
    matches.map((match) => [match.recordId, match.distance]),
    [
      ['chunk-a', 0],
      ['chunk-b', 128],
      ['chunk-c', 192],
    ],
  )

  const best = matches[0]!
  assert.equal(best.chunk.context_text, 'exact')
  assert.deepEqual(best.chunk.source, { doc_token: 'doxcn-source', block_id: 'blk-source' })
  assert.deepEqual(best.chunk.media, [
    { file_token: 'boxcn-asset', type: 'image', caption: 'architecture' },
  ])
  assert.deepEqual(best.chunk.metadata, { lang: 'zh', confidence: 0.9 })
  assert.equal(best.document._id, 'chunk-a')
  assert.equal(typeof best.document.vector_b64, 'string')
  assert.equal(best.document.updated_at instanceof Date, true)
})

test('search honours topK, the default limit and empty indexes', async () => {
  const table = new MemoryTable()
  const db = new VectorizeIndex(table)
  assert.deepEqual(await db.search(embedding(() => true)), [])

  for (let i = 0; i < 7; i++) {
    await db.upsert(
      chunk(`chunk-${i}`, `text ${i}`),
      embedding((index) => index < i * 16),
    )
  }
  assert.equal((await db.search(embedding((index) => index < 0))).length, 5)
  assert.equal((await db.search(embedding((index) => index < 0), 3)).length, 3)
  assert.equal((await db.search(embedding((index) => index < 0), 99)).length, 7)
  await assert.rejects(db.search(embedding(() => true), 0), /topK/)
})

test('a snapshot survives export, reload and a cold database instance', async () => {
  const table = new MemoryTable()
  const warm = new VectorizeIndex(table)
  await warm.upsert(chunk('chunk-a', 'alpha'), embedding((index) => index < 100))
  await warm.upsert(chunk('chunk-b', 'beta'), embedding((index) => index < 200))
  await warm.upsert(chunk('chunk-c', 'gamma'), embedding((index) => index < 300))

  const file = warm.exportSnapshot()
  assert.ok(Buffer.isBuffer(file))
  assert.equal(file.subarray(0, 4).toString('ascii'), 'LFVS')

  const cold = new VectorizeIndex(table)
  assert.equal(cold.loadSnapshot(file), cold)
  assert.equal(cold.size, 3)
  const query = embedding((index) => index < 250)
  assert.deepEqual(await cold.search(query, 3), await warm.search(query, 3))

  const constructed = new VectorizeIndex(table, { snapshot: file })
  assert.equal(constructed.size, 3)
})

test('snapshot loading rejects incompatible dimensions and id widths', async () => {
  const table = new MemoryTable()
  const db = new VectorizeIndex(table)
  await db.upsert(chunk('chunk-a', 'alpha'), embedding((index) => index < 100))
  const file = db.exportSnapshot()

  assert.throws(
    () => new VectorizeIndex(table, { dimensions: 256 }).loadSnapshot(file),
    /snapshot has 512 dimensions/,
  )
  assert.throws(
    () => new VectorizeIndex(table, { idBytes: 32 }).loadSnapshot(file),
    /id slots are 16 bytes/,
  )
})

test('logical ids are validated before any write reaches Bitable', async () => {
  const table = new MemoryTable()
  const db = new VectorizeIndex(table)
  await assert.rejects(
    db.upsert(chunk('x'.repeat(17), 'too long'), embedding(() => true)),
    /17 bytes/,
  )
  assert.equal(table.rows.size, 0)

  const wide = new VectorizeIndex(table, { idBytes: 32 })
  await wide.upsert(chunk('x'.repeat(32), 'fits'), embedding(() => true))
  assert.equal(table.rows.size, 1)
  assert.equal(wide.size, 1)
  await assert.rejects(
    wide.upsert(chunk('x'.repeat(33), 'too long'), embedding(() => true)),
    /33 bytes/,
  )
})

test('chunk and embedding shapes are validated', async () => {
  const table = new MemoryTable()
  const db = new VectorizeIndex(table)

  await assert.rejects(
    db.upsert(chunk('chunk-1', 'x'), new Array(511).fill(1)),
    /512 dimensions/,
  )
  await assert.rejects(
    db.upsert({ ...chunk('chunk-1', 'x'), context_text: 42 as unknown as string }, embedding(() => true)),
    /context_text/,
  )
  await assert.rejects(
    db.upsert({ ...chunk('chunk-1', 'x'), media: null as unknown as [] }, embedding(() => true)),
    /media/,
  )
  await assert.rejects(db.search(new Array(511).fill(1)), /512 dimensions/)
  await assert.rejects(
    db.upsert(chunk('chunk-1', 'x'), [1, Number.NaN, ...new Array(510).fill(1)]),
    /finite/,
  )
})

test('missing Bitable rows degrade gracefully instead of failing the search', async () => {
  const table = new MemoryTable()
  const db = new VectorizeIndex(table)
  await db.upsert(chunk('chunk-a', 'alpha'), embedding((index) => index < 100))
  await db.upsert(chunk('chunk-b', 'beta'), embedding((index) => index < 200))

  table.rows.delete('chunk-a')
  const matches = await db.search(embedding((index) => index < 150), 2)
  assert.deepEqual(matches.map((match) => match.recordId), ['chunk-b'])
})

test('createRecordId returns 16-byte Crockford Base32 ids', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    const id = createRecordId()
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{16}$/)
    assert.equal(Buffer.byteLength(id, 'utf8'), 16)
    seen.add(id)
  }
  assert.equal(seen.size, 1000)
})
