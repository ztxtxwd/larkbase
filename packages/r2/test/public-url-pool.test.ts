import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ValidationError } from '@larkflare/db'
import { PublicUrlPool } from '../src/public-url-pool.js'

test('batches queued tokens into groups of five', async () => {
  const calls: string[][] = []
  const clock = { now: 1_000 }
  const pool = new PublicUrlPool({
    resolve: async (tokens) => {
      calls.push([...tokens])
      return Object.fromEntries(tokens.map((token) => [token, `https://example.test/${token}`]))
    },
    now: () => clock.now,
  })

  const tokens = Array.from({ length: 12 }, (_, index) => `token-${index}`)
  const urls = await Promise.all(tokens.map((token) => pool.get(token)))

  assert.deepEqual(
    calls.map((call) => call.length),
    [5, 5, 2],
  )
  assert.deepEqual(
    urls,
    tokens.map((token) => `https://example.test/${token}`),
  )
})

test('serves cached URLs and refreshes after ttl minus the margin', async () => {
  let calls = 0
  const clock = { now: 10_000 }
  const pool = new PublicUrlPool({
    resolve: async (tokens) => {
      calls++
      return Object.fromEntries(tokens.map((token) => [token, `url-${calls}-${token}`]))
    },
    ttlMs: 1_000,
    refreshMarginMs: 100,
    now: () => clock.now,
  })

  assert.equal(await pool.get('a'), 'url-1-a')
  assert.equal(calls, 1)

  clock.now = 10_899
  assert.equal(await pool.get('a'), 'url-1-a')
  assert.equal(calls, 1)

  clock.now = 10_900
  assert.equal(await pool.get('a'), 'url-2-a')
  assert.equal(calls, 2)
})

test('dedupes concurrent lookups for the same token', async () => {
  const calls: string[][] = []
  const pool = new PublicUrlPool({
    resolve: async (tokens) => {
      calls.push([...tokens])
      return Object.fromEntries(tokens.map((token) => [token, `url-${token}`]))
    },
  })

  const first = pool.get('shared')
  const second = pool.get('shared')
  assert.equal(first, second)
  assert.deepEqual(await Promise.all([first, second]), ['url-shared', 'url-shared'])
  assert.deepEqual(calls, [['shared']])
})

test('rejects tokens the resolver cannot resolve', async () => {
  let calls = 0
  const pool = new PublicUrlPool({
    resolve: async () => {
      calls++
      return {}
    },
  })

  await assert.rejects(pool.get('missing'), /No temporary download URL/)
  assert.equal(calls, 1)
  // The failed entry is removed, so a retry issues a fresh request.
  await assert.rejects(pool.get('missing'), /No temporary download URL/)
  assert.equal(calls, 2)
})

test('rejects a failed batch and recovers on the next call', async () => {
  let calls = 0
  const pool = new PublicUrlPool({
    resolve: async (tokens) => {
      calls++
      if (calls === 1) throw new Error('resolver exploded')
      return Object.fromEntries(tokens.map((token) => [token, `url-${token}`]))
    },
  })

  await assert.rejects(pool.get('a'), /resolver exploded/)
  assert.equal(await pool.get('a'), 'url-a')
  assert.equal(calls, 2)
})

test('rejects non-finite numeric options instead of stalling the queue', () => {
  for (const options of [
    { ttlMs: Number.NaN },
    { refreshMarginMs: Number.NaN },
    { batchSize: Number.NaN },
    { maxEntries: Infinity },
  ]) {
    assert.throws(
      () => new PublicUrlPool({ resolve: async () => ({}), ...options }),
      ValidationError,
    )
  }
})

test('invalidate drops a cached URL, or the whole cache', async () => {
  let calls = 0
  const pool = new PublicUrlPool({
    resolve: async (tokens) => {
      calls++
      return Object.fromEntries(tokens.map((token) => [token, `url-${calls}-${token}`]))
    },
  })

  assert.equal(await pool.get('a'), 'url-1-a')
  pool.invalidate('a')
  assert.equal(await pool.get('a'), 'url-2-a')

  pool.invalidate()
  assert.equal(await pool.get('a'), 'url-3-a')
  assert.equal(calls, 3)
})
