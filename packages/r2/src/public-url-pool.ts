import { LarkflareError, ValidationError } from '@larkflare/db'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_MAX_ENTRIES = 1024

function numericOption(
  value: number | undefined,
  name: string,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${name} must be a finite number`)
  }
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export interface PublicUrlPoolOptions {
  resolve: (tokens: string[]) => Promise<Record<string, string>>
  ttlMs?: number
  refreshMarginMs?: number
  batchSize?: number
  maxEntries?: number
  now?: () => number
}

interface CacheEntry {
  url: string
  expiresAt: number
}

interface PendingEntry {
  promise: Promise<string>
  resolve: (url: string) => void
  reject: (error: unknown) => void
}

/**
 * Caches Feishu temporary download URLs and coalesces lookups into batches of
 * at most five tokens. A queued token is flushed once, in a microtask, so a
 * synchronous burst of requests produces the fewest possible API calls.
 */
export class PublicUrlPool {
  private readonly resolve: (tokens: string[]) => Promise<Record<string, string>>
  private readonly ttlMs: number
  private readonly refreshMarginMs: number
  private readonly batchSize: number
  private readonly maxEntries: number
  private readonly now: () => number

  private readonly cache = new Map<string, CacheEntry>()
  private readonly pending = new Map<string, PendingEntry>()
  private readonly queue: string[] = []
  private flushScheduled = false

  constructor(options: PublicUrlPoolOptions) {
    this.resolve = options.resolve
    this.ttlMs = numericOption(options.ttlMs, 'ttlMs', DEFAULT_TTL_MS, 0)
    this.refreshMarginMs = numericOption(
      options.refreshMarginMs,
      'refreshMarginMs',
      DEFAULT_REFRESH_MARGIN_MS,
      0,
    )
    this.batchSize = numericOption(options.batchSize, 'batchSize', DEFAULT_BATCH_SIZE, 1, 5)
    this.maxEntries = numericOption(options.maxEntries, 'maxEntries', DEFAULT_MAX_ENTRIES, 1)
    this.now = options.now ?? Date.now
  }

  get(token: string): Promise<string> {
    const cached = this.cache.get(token)
    if (cached && cached.expiresAt - this.refreshMarginMs > this.now()) {
      return Promise.resolve(cached.url)
    }
    const inFlight = this.pending.get(token)
    if (inFlight) return inFlight.promise

    let resolveEntry!: (url: string) => void
    let rejectEntry!: (error: unknown) => void
    const promise = new Promise<string>((resolve, reject) => {
      resolveEntry = resolve
      rejectEntry = reject
    })
    this.pending.set(token, { promise, resolve: resolveEntry, reject: rejectEntry })
    this.queue.push(token)
    this.scheduleFlush()
    return promise
  }

  /** Forget one cached URL, or every cached URL when called without a token. */
  invalidate(token?: string): void {
    if (token === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(token)
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      void this.flush().finally(() => {
        this.flushScheduled = false
        // A get() may have queued work during the final await.
        if (this.queue.length > 0) this.scheduleFlush()
      })
    })
  }

  private async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const group = this.queue.splice(0, this.batchSize)
      await this.resolveBatch(group)
    }
  }

  private async resolveBatch(tokens: string[]): Promise<void> {
    let urls: Record<string, string>
    try {
      urls = await this.resolve(tokens)
    } catch (error) {
      for (const token of tokens) {
        const entry = this.pending.get(token)
        if (!entry) continue
        this.pending.delete(token)
        entry.reject(error)
      }
      return
    }

    const expiresAt = this.now() + this.ttlMs
    for (const token of tokens) {
      const entry = this.pending.get(token)
      if (!entry) continue
      this.pending.delete(token)
      const url = urls[token]
      if (!url) {
        entry.reject(
          new LarkflareError(`No temporary download URL returned for file token "${token}"`, {
            code: 'NoPublicUrl',
          }),
        )
        continue
      }
      this.cache.delete(token)
      this.cache.set(token, { url, expiresAt })
      this.evict()
      entry.resolve(url)
    }
  }

  private evict(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}
