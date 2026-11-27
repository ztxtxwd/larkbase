import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '../../core/src/index.js'
import { FakeFeishu } from '../../core/test/fake-feishu.js'
import { LarkVectorDB, VECTOR_TABLE_SCHEMA } from '../src/LarkVectorDB.js'
import type { CompositeChunk, VectorRecord } from '../src/types.js'

function embedding(positive: (index: number) => boolean): number[] {
  return Array.from({ length: 512 }, (_, index) => (positive(index) ? 1 : -1))
}

function chunk(id: string, text: string): CompositeChunk {
  return {
    id,
    source: { doc_token: 'doxcn-e2e', block_id: 'blk-e2e' },
    media: [
      { file_token: 'boxcn-image', type: 'image', caption: '架构图' },
      { file_token: 'boxcn-audio', type: 'audio', time_range: { start_ms: 1_000, end_ms: 4_000 } },
    ],
    context_text: text,
    metadata: { lang: 'zh', tags: ['storage', 'vector'] },
  }
}

test('end-to-end: LarkVectorDB over a real Larkbase table', async () => {
  const fake = await new FakeFeishu().start()
  const client = createClient({
    appId: 'test-app',
    appSecret: 'test-secret',
    domain: fake.url,
    batchWindowMs: 5,
    catalogFlushMs: 0,
  })

  try {
    const table = client
      .useDatabase('vector_e2e')
      .defineTable<VectorRecord>('chunks', VECTOR_TABLE_SCHEMA)
    const vector = new LarkVectorDB(table)

    await vector.upsert(chunk('chunk-a', 'alpha'), embedding((index) => index < 256))
    await vector.upsert(chunk('chunk-b', 'beta'), embedding((index) => index < 128))
    await vector.upsert(chunk('chunk-c', 'gamma'), embedding((index) => index < 64))
    assert.equal(vector.size, 3)

    const query = embedding((index) => index < 256)
    const matches = await vector.search(query, 2)
    assert.deepEqual(
      matches.map((match) => [match.recordId, match.distance]),
      [
        ['chunk-a', 0],
        ['chunk-b', 128],
      ],
    )
    assert.equal(matches[0]!.chunk.context_text, 'alpha')
    assert.deepEqual(matches[0]!.chunk.media, chunk('chunk-a', 'alpha').media)
    assert.deepEqual(matches[0]!.chunk.metadata, { lang: 'zh', tags: ['storage', 'vector'] })
    assert.equal(matches[0]!.document.vector_b64.length, 88)

    // Upsert over the same id updates the existing Bitable row.
    await vector.upsert(chunk('chunk-c', 'gamma v2'), embedding((index) => index < 400))
    assert.equal(vector.size, 3)
    const updated = await vector.search(embedding((index) => index < 400), 1)
    assert.equal(updated[0]!.recordId, 'chunk-c')
    assert.equal(updated[0]!.chunk.context_text, 'gamma v2')

    // Snapshot exported from the warm process restores a cold instance; the
    // second instance fetches documents straight from Bitable.
    const snapshot = vector.exportSnapshot()
    const cold = new LarkVectorDB(table)
    cold.loadSnapshot(snapshot)
    assert.equal(cold.size, 3)
    assert.deepEqual(await cold.search(query, 2), matches)
  } finally {
    await client.close().catch(() => {})
    await fake.stop()
  }
})
