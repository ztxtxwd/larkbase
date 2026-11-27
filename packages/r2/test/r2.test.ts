import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  createClient,
  LarkflareError,
  NotFoundError,
  ValidationError,
} from '../../db/src/index.js'
import { FakeFeishu } from '../../db/test/fake-feishu.js'
import { createR2, type R2 } from '../src/index.js'

interface Context {
  fake: FakeFeishu
  r2: R2
  cleanup: () => Promise<void>
}

async function setup(): Promise<Context> {
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
  const r2 = createR2({ client })
  return {
    fake,
    r2,
    cleanup: async () => {
      await client.close().catch(() => {})
      await fake.stop()
    },
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

test('put/head/get roundtrip, and the upload Feishu receives', async () => {
  const context = await setup()
  try {
    const bucket = await context.r2.createBucket('photos')
    const bytes = Buffer.from('hello object')
    const metadata = { owner: 'ada', 'trace/id': 'a/b' }

    const put = await bucket.putObject('docs/hello.txt', bytes, { metadata })
    const etag = sha256Hex(bytes)
    assert.equal(put.key, 'docs/hello.txt')
    assert.equal(put.size, bytes.byteLength)
    assert.equal(put.etag, etag)
    assert.equal(put.contentType, 'text/plain; charset=utf-8')
    assert.deepEqual(put.metadata, metadata)
    assert.ok(put.lastModified instanceof Date)
    assert.match(put.fileToken, /^box/)

    const head = await bucket.headObject('docs/hello.txt')
    assert.deepEqual(
      {
        key: head.key,
        size: head.size,
        etag: head.etag,
        contentType: head.contentType,
        metadata: head.metadata,
        fileToken: head.fileToken,
      },
      {
        key: 'docs/hello.txt',
        size: bytes.byteLength,
        etag,
        contentType: 'text/plain; charset=utf-8',
        metadata,
        fileToken: put.fileToken,
      },
    )
    assert.equal(head.lastModified.getTime(), put.lastModified.getTime())

    const object = await bucket.getObject('docs/hello.txt')
    assert.deepEqual(object.body, bytes)
    assert.equal(object.etag, etag)
    assert.equal(object.fileToken, put.fileToken)

    const buckets = await context.r2.listBuckets()
    const info = buckets.find((entry) => entry.name === 'photos')
    assert.ok(info, 'listBuckets should report the new bucket')

    const upload = context.fake.callsMatching('POST', '/medias/upload_all')[0]
    assert.ok(upload, 'expected one simple media upload')
    const form = upload.body as FormData
    assert.equal(form.get('file_name'), 'hello.txt')
    assert.equal(form.get('parent_type'), 'bitable_file')
    assert.equal(form.get('parent_node'), info.baseToken)
  } finally {
    await context.cleanup()
  }
})

test('infers image content type, parent type and file extension', async () => {
  const context = await setup()
  try {
    const bucket = await context.r2.createBucket('images')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])
    const put = await bucket.putObject('img/cat.png', bytes)

    assert.equal(put.contentType, 'image/png')
    const head = await bucket.headObject('img/cat.png')
    assert.equal(head.contentType, 'image/png')

    const upload = context.fake.callsMatching('POST', '/medias/upload_all')[0]
    assert.ok(upload, 'expected one simple media upload')
    const form = upload.body as FormData
    assert.equal(form.get('file_name'), 'cat.png')
    assert.equal(form.get('parent_type'), 'bitable_image')
    assert.match(String(form.get('file_name')), /\.png$/)
  } finally {
    await context.cleanup()
  }
})

test('overwriting a key updates one row and serves the new bytes', async () => {
  const context = await setup()
  try {
    const bucket = await context.r2.createBucket('overwrite')
    const first = await bucket.putObject('a.txt', Buffer.from('one'))
    const second = await bucket.putObject('a.txt', Buffer.from('two two'))

    assert.notEqual(first.etag, second.etag)
    assert.notEqual(first.fileToken, second.fileToken)

    const head = await bucket.headObject('a.txt')
    assert.equal(head.size, 7)
    assert.equal(head.etag, second.etag)

    const list = await bucket.listObjects({ prefix: 'a' })
    assert.equal(list.objects.length, 1)
    assert.equal(list.objects[0]!.etag, second.etag)

    const object = await bucket.getObject('a.txt')
    assert.deepEqual(object.body, Buffer.from('two two'))
  } finally {
    await context.cleanup()
  }
})

test('objects above 20 MB roundtrip byte-exactly through chunked upload', { timeout: 120_000 }, async () => {
  const context = await setup()
  try {
    const bucket = await context.r2.createBucket('large')
    const bytes = Buffer.alloc(21 * 1024 * 1024, 0x61)
    await bucket.putObject('large/data.bin', bytes)

    const object = await bucket.getObject('large/data.bin')
    assert.equal(object.size, bytes.byteLength)
    assert.equal(object.body.byteLength, bytes.byteLength)
    assert.ok(object.body.equals(bytes))
    assert.equal(object.etag, sha256Hex(bytes))

    const prepares = context.fake.callsMatching('POST', '/medias/upload_prepare')
    assert.ok(prepares.length >= 1, 'expected the chunked upload prepare call')
  } finally {
    await context.cleanup()
  }
})

test('getPublicUrl returns a working unauthenticated link and batches lookups', async () => {
  const context = await setup()
  try {
    const bucket = await context.r2.createBucket('public')
    const bytes = Buffer.from('public bytes')
    await bucket.putObject('a.txt', bytes)

    const before = context.fake.tmpUrlRequests.length
    const url = await bucket.getPublicUrl('a.txt')
    assert.equal(context.fake.tmpUrlRequests.length, before + 1)
    assert.ok(url.startsWith(`${context.fake.url}/__tmp/`))

    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)

    await bucket.getPublicUrl('a.txt')
    assert.equal(context.fake.tmpUrlRequests.length, before + 1, 'cached URL must not refetch')

    const keys = Array.from({ length: 7 }, (_, index) => `batch/${index}.bin`)
    for (const key of keys) await bucket.putObject(key, Buffer.from(key))
    context.fake.tmpUrlRequests.length = 0

    const urls = await bucket.getPublicUrls(keys)
    assert.equal(Object.keys(urls).length, 7)
    assert.equal(context.fake.tmpUrlRequests.length, 2)
    assert.deepEqual(
      context.fake.tmpUrlRequests.map((request) => request.length).sort((a, b) => a - b),
      [2, 5],
    )
    for (const key of keys) {
      const fetched = await fetch(urls[key]!)
      assert.equal(fetched.status, 200)
      assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), Buffer.from(key))
    }

    await bucket.deleteObject('a.txt')
    await assert.rejects(
      bucket.getPublicUrl('a.txt'),
      (error: unknown) => error instanceof NotFoundError && error.code === 'NoSuchKey',
    )
  } finally {
    await context.cleanup()
  }
})

test('getPublicUrl separates missing rows from empty attachment cells', async () => {
  const context = await setup()
  try {
    const bucket = await context.r2.createBucket('empty-cell')
    await bucket.putObject('present.txt', Buffer.from('x'))

    const base = [...context.fake.bases.values()].find(
      (candidate) => candidate.name === 'larkflare:r2:empty-cell',
    )
    assert.ok(base, 'expected the bucket Base')
    const table = [...base.tables.values()].find((candidate) => candidate.name === 'objects')
    assert.ok(table, 'expected the objects table')
    const record = [...table.records.values()].find((candidate) => candidate.fields._id === 'present.txt')
    assert.ok(record, 'expected the object row')
    record.fields.data = []

    await assert.rejects(
      bucket.getPublicUrl('present.txt'),
      (error: unknown) =>
        error instanceof LarkflareError &&
        !(error instanceof NotFoundError) &&
        /attachment/.test(error.message),
    )
    await assert.rejects(
      bucket.getPublicUrl('absent.txt'),
      (error: unknown) => error instanceof NotFoundError && error.code === 'NoSuchKey',
    )
  } finally {
    await context.cleanup()
  }
})

test('listObjects applies prefix, delimiter, pagination and startAfter', async () => {
  const context = await setup()
  try {
    const bucket = await context.r2.createBucket('listing')
    for (const key of ['a/1.txt', 'a/2.txt', 'a/sub/3.txt', 'b/1.txt', 'c.txt']) {
      await bucket.putObject(key, Buffer.from(key))
    }

    const byPrefix = await bucket.listObjects({ prefix: 'a/' })
    assert.deepEqual(
      byPrefix.objects.map((object) => object.key),
      ['a/1.txt', 'a/2.txt', 'a/sub/3.txt'],
    )
    assert.deepEqual(byPrefix.commonPrefixes, [])
    assert.equal(byPrefix.isTruncated, false)

    const byDelimiter = await bucket.listObjects({ prefix: 'a/', delimiter: '/' })
    assert.deepEqual(
      byDelimiter.objects.map((object) => object.key),
      ['a/1.txt', 'a/2.txt'],
    )
    assert.deepEqual(byDelimiter.commonPrefixes, ['a/sub/'])
    assert.equal(byDelimiter.isTruncated, false)

    const root = await bucket.listObjects({ delimiter: '/' })
    assert.deepEqual(
      root.objects.map((object) => object.key),
      ['c.txt'],
    )
    assert.deepEqual(root.commonPrefixes, ['a/', 'b/'])
    assert.equal(root.isTruncated, false)

    const pageKeys = ['p/1', 'p/2', 'p/3', 'p/4', 'p/5']
    for (const key of pageKeys) await bucket.putObject(key, Buffer.from(key))

    const collected: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const page = await bucket.listObjects({ prefix: 'p/', limit: 2, cursor })
      assert.ok(page.objects.length <= 2)
      collected.push(...page.objects.map((object) => object.key))
      pages++
      assert.ok(pages < 10, 'pagination should terminate')
      if (!page.isTruncated) break
      assert.ok(page.nextContinuationToken)
      cursor = page.nextContinuationToken
    }
    assert.equal(pages, 3)
    assert.deepEqual(collected, pageKeys)
    assert.equal(new Set(collected).size, collected.length)

    const after = await bucket.listObjects({ prefix: 'p/', startAfter: 'p/3' })
    assert.deepEqual(
      after.objects.map((object) => object.key),
      ['p/4', 'p/5'],
    )
  } finally {
    await context.cleanup()
  }
})

test('deleteObject is idempotent and getObject then raises NoSuchKey', async () => {
  const context = await setup()
  try {
    const bucket = await context.r2.createBucket('deleting')
    await bucket.putObject('gone.txt', Buffer.from('x'))

    assert.equal(await bucket.deleteObject('gone.txt'), true)
    assert.equal(await bucket.deleteObject('gone.txt'), false)
    await assert.rejects(
      bucket.getObject('gone.txt'),
      (error: unknown) => error instanceof NotFoundError && error.code === 'NoSuchKey',
    )
  } finally {
    await context.cleanup()
  }
})

test('object keys never alias raw Bitable record ids', async () => {
  const context = await setup()
  try {
    const bucket = await context.r2.createBucket('aliasing')
    await bucket.putObject('victim.txt', Buffer.from('original'))

    const base = [...context.fake.bases.values()].find(
      (candidate) => candidate.name === 'larkflare:r2:aliasing',
    )
    assert.ok(base, 'expected the bucket Base')
    const table = [...base.tables.values()].find((candidate) => candidate.name === 'objects')
    assert.ok(table, 'expected the objects table')
    const recordId = [...table.records.keys()][0]
    assert.ok(recordId, 'expected a stored record')
    assert.match(recordId, /^rec/)

    await assert.rejects(
      bucket.getObject(recordId),
      (error: unknown) => error instanceof NotFoundError && error.code === 'NoSuchKey',
    )
    await assert.rejects(bucket.headObject(recordId), NotFoundError)
    await assert.rejects(bucket.getPublicUrl(recordId), NotFoundError)

    // A key that looks like another row's record id must create its own row,
    // not overwrite that row.
    await bucket.putObject(recordId, Buffer.from('decoy'))
    assert.equal((await bucket.getObject('victim.txt')).body.toString(), 'original')
    assert.equal((await bucket.getObject(recordId)).body.toString(), 'decoy')

    assert.equal(await bucket.deleteObject(recordId), true)
    assert.equal((await bucket.getObject('victim.txt')).body.toString(), 'original')
  } finally {
    await context.cleanup()
  }
})

test('rejects non-finite numeric options', async () => {
  const context = await setup()
  try {
    assert.throws(
      () => createR2({ client: context.r2.client, listScanLimit: Number.NaN }),
      ValidationError,
    )
    assert.throws(
      () => createR2({ client: context.r2.client, publicUrlBatchSize: Number.NaN }),
      ValidationError,
    )
  } finally {
    await context.cleanup()
  }
})

test('validates bucket names, keys, bodies, metadata and cursors', async () => {
  const context = await setup()
  try {
    for (const name of ['ab', 'UPPER', '-bad', 'bad-', 'a..b', '192.168.1.1']) {
      assert.throws(() => context.r2.bucket(name), ValidationError)
    }

    const bucket = await context.r2.createBucket('boundary')
    await assert.rejects(bucket.putObject('', Buffer.from('x')), ValidationError)
    await assert.rejects(bucket.putObject('a\u0000b', Buffer.from('x')), ValidationError)
    await assert.rejects(bucket.putObject('a\u007fb', Buffer.from('x')), ValidationError)
    await assert.rejects(bucket.putObject('a'.repeat(1025), Buffer.from('x')), ValidationError)
    await assert.rejects(bucket.putObject('empty', Buffer.alloc(0)), ValidationError)
    await assert.rejects(
      bucket.putObject('meta', Buffer.from('x'), {
        metadata: { n: 1 } as unknown as Record<string, string>,
      }),
      ValidationError,
    )
    await assert.rejects(
      bucket.putObject('proto', Buffer.from('x'), {
        metadata: JSON.parse('{"__proto__":"polluted"}'),
      }),
      ValidationError,
    )
    await assert.rejects(bucket.listObjects({ cursor: '!!!' }), ValidationError)
  } finally {
    await context.cleanup()
  }
})
