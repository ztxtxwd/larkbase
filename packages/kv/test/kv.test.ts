import assert from 'node:assert/strict'
import { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { ReadableStream } from 'node:stream/web'
import { test } from 'node:test'
import {
  createClient,
  LarkflareError,
  ValidationError,
  type Larkflare,
  type Table,
} from '../../db/src/index.js'
import { FakeFeishu } from '../../db/test/fake-feishu.js'
import {
  createKV,
  KV_ENTRIES_SCHEMA,
  KV_ENTRIES_TABLE,
  KV_MAX_VALUE_BYTES,
  KVNamespace,
  type KV,
} from '../src/index.js'

interface Context {
  fake: FakeFeishu
  client: Larkflare
  kv: KV
  cleanup: () => Promise<void>
}

async function setup(options: { listScanLimit?: number } = {}): Promise<Context> {
  const fake = await new FakeFeishu().start()
  const client = createClient({
    appId: 'test-app',
    appSecret: 'test-secret',
    domain: fake.url,
    bitableQps: 100,
    driveQps: 100,
    batchWindowMs: 0,
    catalogFlushMs: 0,
  })
  const kv = createKV({ client, listScanLimit: options.listScanLimit })
  return {
    fake,
    client,
    kv,
    cleanup: async () => {
      await client.close().catch(() => {})
      await fake.stop()
    },
  }
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

function streamOf(bytes: Uint8Array): NodeReadableStream<Uint8Array> {
  return new NodeReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function uploads(fake: FakeFeishu): number {
  return fake.callsMatching('POST', '/medias/upload_all').length
}

async function entriesTable(client: Larkflare, namespace: string): Promise<Table> {
  const database = client.useDatabase(`kv:${namespace}`)
  return database.defineTable(KV_ENTRIES_TABLE, KV_ENTRIES_SCHEMA)
}

test('text put/get roundtrip, overwrite, delete and missing keys', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('app')

    assert.equal(await ns.get('missing'), null)
    assert.deepEqual(await ns.getWithMetadata('missing'), { value: null, metadata: null })

    await ns.put('greeting', 'hello')
    assert.equal(await ns.get('greeting'), 'hello')
    assert.equal(await ns.get('greeting', 'text'), 'hello')

    await ns.put('greeting', 'world')
    assert.equal(await ns.get('greeting'), 'world')

    await ns.delete('greeting')
    assert.equal(await ns.get('greeting'), null)
    await ns.delete('greeting') // idempotent
    assert.equal(await ns.get('greeting'), null)
  } finally {
    await context.cleanup()
  }
})

test('json, arrayBuffer and stream views over every accepted input', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('views')

    await ns.put('from-string', '{"ok":true,"n":1}')
    assert.deepEqual(await ns.get<{ ok: boolean; n: number }>('from-string', 'json'), {
      ok: true,
      n: 1,
    })
    assert.equal(await ns.get('from-string'), '{"ok":true,"n":1}')

    const jsonBytes = Buffer.from('{"from":"bytes"}', 'utf8')
    await ns.put('from-uint8', new Uint8Array(jsonBytes))
    assert.deepEqual(await ns.get<{ from: string }>('from-uint8', 'json'), { from: 'bytes' })
    assert.equal(Buffer.from((await ns.get('from-uint8', 'arrayBuffer'))!).toString('utf8'), jsonBytes.toString())

    const bufferBytes = Buffer.from('buffer value', 'utf8')
    await ns.put('from-buffer', bufferBytes)
    assert.equal(await ns.get('from-buffer'), 'buffer value')
    assert.deepEqual(Buffer.from((await ns.get('from-buffer', 'arrayBuffer'))!), bufferBytes)

    const arrayBuffer = jsonBytes.buffer.slice(
      jsonBytes.byteOffset,
      jsonBytes.byteOffset + jsonBytes.byteLength,
    ) as ArrayBuffer
    await ns.put('from-arraybuffer', arrayBuffer)
    assert.deepEqual(Buffer.from((await ns.get('from-arraybuffer', 'arrayBuffer'))!), jsonBytes)

    await ns.put('from-stream', streamOf(new Uint8Array(Buffer.from('stream text', 'utf8'))))
    assert.equal(await ns.get('from-stream'), 'stream text')
    assert.deepEqual(
      await collectStream((await ns.get('from-stream', 'stream'))!),
      Buffer.from('stream text', 'utf8'),
    )

    // encoding is storage metadata only: text written as a string reads as bytes.
    assert.deepEqual(
      Buffer.from((await ns.get('from-stream', 'arrayBuffer'))!),
      Buffer.from('stream text', 'utf8'),
    )

    // options-object form, including cacheTtl which the adapter ignores.
    assert.deepEqual(
      await ns.get<{ ok: boolean; n: number }>('from-string', { type: 'json', cacheTtl: 30 }),
      { ok: true, n: 1 },
    )
    assert.equal(
      Buffer.from((await ns.get('from-string', { type: 'arrayBuffer', cacheTtl: 30 }))!).toString(
        'utf8',
      ),
      '{"ok":true,"n":1}',
    )
    assert.deepEqual(
      await collectStream((await ns.get('from-string', { type: 'stream', cacheTtl: 30 }))!),
      Buffer.from('{"ok":true,"n":1}', 'utf8'),
    )
    assert.equal(typeof (await ns.get('from-string', { cacheTtl: 30 })), 'string')

    // Invalid JSON lets JSON.parse throw rather than being swallowed.
    await ns.put('bad-json', 'not json')
    await assert.rejects(ns.get('bad-json', 'json'), SyntaxError)
  } finally {
    await context.cleanup()
  }
})

test('empty string and zero-byte binary are valid values', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('empty')
    await ns.put('empty-text', '')
    assert.equal(await ns.get('empty-text'), '')
    assert.equal((await ns.get('empty-text', 'arrayBuffer'))!.byteLength, 0)

    await ns.put('empty-binary', new Uint8Array(0))
    assert.equal(await ns.get('empty-binary'), '')
    assert.equal((await ns.get('empty-binary', 'arrayBuffer'))!.byteLength, 0)
  } finally {
    await context.cleanup()
  }
})

test('small binary stays inline and larger binary becomes an attachment', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('binary')

    const small = new Uint8Array([1, 2, 3, 4])
    await ns.put('small', small)
    assert.deepEqual(Buffer.from((await ns.get('small', 'arrayBuffer'))!), Buffer.from(small))
    assert.equal(uploads(context.fake), 0, 'small binary must not upload media')

    const large = Buffer.alloc(16 * 1024 + 1, 0x42)
    const before = uploads(context.fake)
    await ns.put('large', large)
    assert.ok(uploads(context.fake) > before, 'large binary must upload an attachment')
    const roundtrip = Buffer.from((await ns.get('large', 'arrayBuffer'))!)
    assert.equal(roundtrip.byteLength, large.byteLength)
    assert.ok(roundtrip.equals(large))
  } finally {
    await context.cleanup()
  }
})

test('metadata is stored, surfaced in list, cleared on overwrite and validated', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('metadata')

    await ns.put('greeting', 'hello', { metadata: { owner: 'ada', n: 1 } })
    const stored = await ns.getWithMetadata('greeting')
    assert.equal(stored.value, 'hello')
    assert.deepEqual(stored.metadata, { owner: 'ada', n: 1 })

    // The Metadata generic works on the no-type and 'text' overloads.
    const typed = await ns.getWithMetadata<{ owner: string }>('greeting')
    assert.equal(typed.metadata?.owner, 'ada')
    const typedText = await ns.getWithMetadata<{ owner: string }>('greeting', 'text')
    assert.equal(typedText.metadata?.owner, 'ada')

    const listed = await ns.list({ prefix: 'greeting' })
    assert.deepEqual(listed.keys[0]!.metadata, { owner: 'ada', n: 1 })

    await ns.put('greeting', 'hello again')
    assert.deepEqual(await ns.getWithMetadata('greeting'), {
      value: 'hello again',
      metadata: null,
    })

    await assert.rejects(
      ns.put('too-big', 'x', { metadata: { text: 'a'.repeat(1100) } }),
      ValidationError,
    )

    const circular: Record<string, unknown> = {}
    circular.self = circular
    await assert.rejects(ns.put('circular', 'x', { metadata: circular }), ValidationError)
  } finally {
    await context.cleanup()
  }
})

test('expiration options are validated and surfaced in list', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('expiration')
    const now = Math.floor(Date.now() / 1000)

    await ns.put('relative', 'x', { expirationTtl: 3600 })
    const afterTtl = Math.floor(Date.now() / 1000)
    const relative = (await ns.list({ prefix: 'relative' })).keys[0]!
    assert.equal(typeof relative.expiration, 'number')
    assert.ok(relative.expiration! >= now + 3600)
    assert.ok(relative.expiration! <= afterTtl + 3600)

    const absolute = now + 7200
    await ns.put('absolute', 'x', { expiration: absolute })
    const listedAbsolute = (await ns.list({ prefix: 'absolute' })).keys[0]!
    assert.equal(listedAbsolute.expiration, absolute)

    await assert.rejects(
      ns.put('both', 'x', { expiration: now + 3600, expirationTtl: 3600 }),
      ValidationError,
    )
    await assert.rejects(ns.put('short-ttl', 'x', { expirationTtl: 59 }), ValidationError)
    await assert.rejects(
      ns.put('short-absolute', 'x', { expiration: now + 59 }),
      ValidationError,
    )
    await assert.rejects(ns.put('past', 'x', { expiration: now - 60 }), ValidationError)
  } finally {
    await context.cleanup()
  }
})

test('expired rows are hidden from get, getWithMetadata and list', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('expiring')
    await ns.put('live', 'yes', { expirationTtl: 3600 })

    const table = await entriesTable(context.client, 'expiring')
    await table.insertOne({
      _id: 'dead',
      encoding: 'utf8',
      value: 'gone',
      data: null,
      metadata: null,
      expiration: Math.floor(Date.now() / 1000) - 1,
    })

    assert.equal(await ns.get('dead'), null)
    assert.deepEqual(await ns.getWithMetadata('dead'), { value: null, metadata: null })
    const listed = await ns.list()
    assert.deepEqual(
      listed.keys.map((key) => key.name),
      ['live'],
    )
  } finally {
    await context.cleanup()
  }
})

test('list sorts lexicographically, filters by prefix and paginates by cursor', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('listing')

    for (const key of ['b', 'a', 'd', 'c', 'e']) await ns.put(key, key)
    const all = await ns.list()
    assert.deepEqual(
      all.keys.map((key) => key.name),
      ['a', 'b', 'c', 'd', 'e'],
    )
    assert.equal(all.list_complete, true)
    assert.equal(all.cursor, undefined)

    for (let index = 1; index <= 5; index++) await ns.put(`p/${index}`, String(index))
    await ns.put('q/1', 'q')

    const prefixed = await ns.list({ prefix: 'p/' })
    assert.deepEqual(
      prefixed.keys.map((key) => key.name),
      ['p/1', 'p/2', 'p/3', 'p/4', 'p/5'],
    )

    const collected: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const page = await ns.list({ prefix: 'p/', limit: 2, cursor })
      assert.ok(page.keys.length <= 2)
      collected.push(...page.keys.map((key) => key.name))
      pages++
      assert.ok(pages < 10, 'pagination should terminate')
      if (page.list_complete) {
        assert.equal(page.cursor, undefined)
        break
      }
      assert.equal(typeof page.cursor, 'string')
      cursor = page.cursor
    }
    assert.equal(pages, 3)
    assert.deepEqual(collected, ['p/1', 'p/2', 'p/3', 'p/4', 'p/5'])
    assert.equal(new Set(collected).size, collected.length)

    // A page whose size equals the eligible count is complete, with no cursor.
    const exact = await ns.list({ prefix: 'q/', limit: 1 })
    assert.equal(exact.list_complete, true)
    assert.equal(exact.cursor, undefined)
    assert.deepEqual(
      exact.keys.map((key) => key.name),
      ['q/1'],
    )

    await assert.rejects(ns.list({ cursor: '!!!' }), ValidationError)
  } finally {
    await context.cleanup()
  }
})

test('limit above 1000 is clamped to 1000', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('clamped')
    const table = await entriesTable(context.client, 'clamped')

    const docs = Array.from({ length: 1001 }, (_, index) => ({
      _id: `k${String(index).padStart(4, '0')}`,
      encoding: 'utf8',
      value: 'v',
      data: null,
      metadata: null,
      expiration: null,
    }))
    for (let offset = 0; offset < docs.length; offset += 500) {
      await Promise.all(docs.slice(offset, offset + 500).map((doc) => table.insertOne(doc)))
    }

    const page = await ns.list({ limit: 5000 })
    assert.equal(page.keys.length, 1000)
    assert.equal(page.list_complete, false)
    assert.equal(typeof page.cursor, 'string')
  } finally {
    await context.cleanup()
  }
})

test('validates keys and value sizes', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('validation')

    await assert.rejects(ns.put('', 'x'), ValidationError)
    await assert.rejects(ns.put('.', 'x'), ValidationError)
    await assert.rejects(ns.put('..', 'x'), ValidationError)
    await assert.rejects(ns.get('.'), ValidationError)
    await assert.rejects(ns.delete('..'), ValidationError)
    await assert.rejects(ns.put('a'.repeat(513), 'x'), ValidationError)
    await assert.rejects(ns.put('é'.repeat(257), 'x'), ValidationError)

    const maxKey = 'a'.repeat(512)
    await ns.put(maxKey, 'max')
    assert.equal(await ns.get(maxKey), 'max')

    const twoByteKey = 'é'.repeat(256)
    await ns.put(twoByteKey, 'two-byte')
    assert.equal(await ns.get(twoByteKey), 'two-byte')

    await assert.rejects(ns.put('huge', Buffer.alloc(KV_MAX_VALUE_BYTES + 1)), ValidationError)
    await assert.rejects(ns.put('bad-type', 42 as any), ValidationError)
    await assert.rejects(ns.put('null-type', null as any), ValidationError)
  } finally {
    await context.cleanup()
  }
})

test('namespaces are lazy, idempotent, discoverable and validated', async () => {
  const context = await setup()
  try {
    const first = await context.kv.createNamespace('alpha')
    const second = await context.kv.createNamespace('alpha')
    assert.equal(first, second)
    assert.ok(first instanceof KVNamespace)
    assert.equal(first.name, 'alpha')

    assert.equal(context.kv.useNamespace('alpha'), first)

    const lazy = context.kv.namespace('lazy')
    let names = await context.kv.listNamespaces()
    assert.ok(
      names.some((entry) => entry.name === 'alpha'),
      'alpha should be discovered',
    )
    assert.ok(
      !names.some((entry) => entry.name === 'lazy'),
      'a lazy handle must not create a database yet',
    )

    await lazy.put('k', 'v')
    names = await context.kv.listNamespaces()
    const lazyInfo = names.find((entry) => entry.name === 'lazy')
    assert.ok(lazyInfo)
    assert.match(lazyInfo.baseToken, /^bascn/)

    // Databases outside the kv: prefix, and invalid kv: suffixes, are filtered.
    await context.client.useDatabase('other:schema').ensure()
    await context.client.useDatabase(`kv:${'x'.repeat(101)}`).ensure()
    names = await context.kv.listNamespaces()
    assert.ok(!names.some((entry) => entry.name.startsWith('other')))
    assert.ok(!names.some((entry) => entry.name.length > 100))

    for (const bad of ['', 'x'.repeat(101), 'bad\u0001name', 'del\u007fname']) {
      assert.throws(() => context.kv.namespace(bad), ValidationError)
    }
  } finally {
    await context.cleanup()
  }
})

test('keys that look like Bitable record ids roundtrip without aliasing', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('aliasing')
    await ns.put('victim', 'original')

    const base = [...context.fake.bases.values()].find(
      (candidate) => candidate.name === 'larkflare:kv:aliasing',
    )
    assert.ok(base, 'expected the namespace Base')
    const table = [...base.tables.values()].find((candidate) => candidate.name === KV_ENTRIES_TABLE)
    assert.ok(table, 'expected the entries table')
    const recordId = [...table.records.keys()][0]
    assert.ok(recordId)
    assert.match(recordId, /^rec/)

    assert.equal(await ns.get(recordId), null)
    assert.deepEqual(await ns.getWithMetadata(recordId), { value: null, metadata: null })

    await ns.put(recordId, 'decoy')
    assert.equal(await ns.get('victim'), 'original')
    assert.equal(await ns.get(recordId), 'decoy')
    const listed = await ns.list()
    assert.deepEqual(
      listed.keys.map((key) => key.name).sort(),
      [recordId, 'victim'].sort(),
    )
  } finally {
    await context.cleanup()
  }
})

test('concurrent puts of a new key leave exactly one row', async () => {
  const context = await setup()
  try {
    const ns = await context.kv.createNamespace('racing')
    const values = ['one', 'two', 'three', 'four', 'five']
    await Promise.all(values.map((value) => ns.put('same-key', value)))

    const listed = await ns.list({ prefix: 'same-key' })
    assert.equal(listed.keys.length, 1)
    assert.equal(listed.keys[0]!.name, 'same-key')
    assert.ok(values.includes((await ns.get('same-key'))!))
  } finally {
    await context.cleanup()
  }
})

test('listScanLimit is enforced with LarkflareError code ListScanLimitExceeded', async () => {
  const context = await setup({ listScanLimit: 2 })
  try {
    const ns = await context.kv.createNamespace('scan')
    await ns.put('a', '1')
    await ns.put('b', '2')
    await ns.put('c', '3')

    await assert.rejects(
      ns.list(),
      (error: unknown) =>
        error instanceof LarkflareError && error.code === 'ListScanLimitExceeded',
    )
  } finally {
    await context.cleanup()
  }
})
