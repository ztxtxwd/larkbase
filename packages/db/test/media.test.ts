import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '../src/index.js'
import { FakeFeishu } from './fake-feishu.js'

test('uploadMedia + getTempDownloadUrls: public URLs serve bytes without auth', async () => {
  const fake = await new FakeFeishu().start()
  const client = createClient({
    appId: 'test-app',
    appSecret: 'test-secret',
    domain: fake.url,
    bitableQps: 100,
    driveQps: 100,
  })
  try {
    const alpha = Buffer.from('alpha bytes')
    const beta = Buffer.from('beta bytes, a bit longer')
    const first = await client.uploadMedia({
      parentToken: 'bascnparent',
      bytes: alpha,
      fileName: 'alpha.bin',
      parentType: 'bitable_file',
    })
    const second = await client.uploadMedia({
      parentToken: 'bascnparent',
      bytes: beta,
      fileName: 'beta.png',
      parentType: 'bitable_image',
    })
    assert.equal(first.size, alpha.byteLength)
    assert.equal(second.size, beta.byteLength)

    const urls = await client.getTempDownloadUrls([first.fileToken, second.fileToken])
    assert.deepEqual(Object.keys(urls).sort(), [first.fileToken, second.fileToken].sort())
    assert.ok(urls[first.fileToken]!.includes('/__tmp/'))
    assert.ok(urls[second.fileToken]!.includes('/__tmp/'))

    for (const [token, bytes] of [
      [first.fileToken, alpha],
      [second.fileToken, beta],
    ] as const) {
      const response = await fetch(urls[token]!)
      assert.equal(response.status, 200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    }
    assert.equal(fake.tmpUrlRequests.length, 1)
    assert.equal(fake.tmpUrlRequests[0]!.length, 2)
  } finally {
    await client.close().catch(() => {})
    await fake.stop()
  }
})

test('getTempDownloadUrls chunks at five tokens per request', async () => {
  const fake = await new FakeFeishu().start()
  const client = createClient({
    appId: 'test-app',
    appSecret: 'test-secret',
    domain: fake.url,
    bitableQps: 100,
    driveQps: 100,
  })
  try {
    const tokens: string[] = []
    for (let index = 0; index < 6; index++) {
      const uploaded = await client.uploadMedia({
        parentToken: 'bascnparent',
        bytes: Buffer.from(`payload-${index}`),
        fileName: `file-${index}.bin`,
      })
      tokens.push(uploaded.fileToken)
    }
    fake.tmpUrlRequests.length = 0

    const urls = await client.getTempDownloadUrls(tokens)
    assert.equal(Object.keys(urls).length, 6)
    assert.equal(fake.tmpUrlRequests.length, 2)
    assert.deepEqual(
      fake.tmpUrlRequests.map((request) => request.length),
      [5, 1],
    )
    assert.deepEqual(fake.tmpUrlRequests.flat().sort(), [...tokens].sort())
  } finally {
    await client.close().catch(() => {})
    await fake.stop()
  }
})

test('getTempDownloadUrls omits unknown and duplicate tokens', async () => {
  const fake = await new FakeFeishu().start()
  const client = createClient({
    appId: 'test-app',
    appSecret: 'test-secret',
    domain: fake.url,
    bitableQps: 100,
    driveQps: 100,
  })
  try {
    const uploaded = await client.uploadMedia({
      parentToken: 'bascnparent',
      bytes: Buffer.from('known'),
      fileName: 'known.bin',
    })
    fake.tmpUrlRequests.length = 0

    const urls = await client.getTempDownloadUrls([
      uploaded.fileToken,
      uploaded.fileToken,
      '',
      'boxmissing00000000',
    ])
    assert.deepEqual(Object.keys(urls), [uploaded.fileToken])
    assert.equal(fake.tmpUrlRequests.length, 1)
    // Duplicates and empty tokens are dropped before the call; the unknown
    // token is still sent, and simply omitted from the result.
    assert.deepEqual(fake.tmpUrlRequests[0], [uploaded.fileToken, 'boxmissing00000000'])
    assert.deepEqual(
      await client.getTempDownloadUrls(['boxmissing00000000']),
      {},
    )
  } finally {
    await client.close().catch(() => {})
    await fake.stop()
  }
})
