import { createClient, ValidationError, type Larkflare, type LarkflareConfig } from '@larkflare/db'
import { R2Bucket } from './bucket.js'
import { isValidBucketName, validateBucketName } from './keys.js'
import { Mutex } from './mutex.js'
import { PublicUrlPool } from './public-url-pool.js'
import type { R2BucketInfo } from './types.js'

export interface R2Options extends LarkflareConfig {
  /** Reuse an existing Larkflare client instead of creating one. */
  client?: Larkflare
  /** Cached temporary download URL lifetime. Defaults to 24 hours. */
  publicUrlTtlMs?: number
  /** Refresh cached URLs this long before they expire. Defaults to 5 minutes. */
  publicUrlRefreshMarginMs?: number
  /** Tokens per Feishu temp-URL request. Clamped to 1..5. Defaults to 5. */
  publicUrlBatchSize?: number
  /** Rows listObjects may scan per call. Defaults to 100,000. */
  listScanLimit?: number
}

const BUCKET_PREFIX = 'r2:'
const DEFAULT_LIST_SCAN_LIMIT = 100_000

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive finite number`)
  }
  return Math.max(1, Math.floor(value))
}

/**
 * S3-style object storage over Feishu Drive.
 *
 * Each bucket is a Larkflare database named `r2:<bucket>`; each object is a row
 * in its `objects` table plus one Bitable attachment media file.
 */
export class R2 {
  readonly client: Larkflare

  private readonly buckets = new Map<string, R2Bucket>()
  private readonly uploadMutex = new Mutex()
  private readonly publicUrls: PublicUrlPool
  private readonly listScanLimit: number

  constructor(options: R2Options) {
    this.client = options.client ?? createClient(options)
    this.listScanLimit = positiveInteger(
      options.listScanLimit,
      'listScanLimit',
      DEFAULT_LIST_SCAN_LIMIT,
    )
    this.publicUrls = new PublicUrlPool({
      resolve: (tokens) => this.client.getTempDownloadUrls(tokens),
      ttlMs: options.publicUrlTtlMs,
      refreshMarginMs: options.publicUrlRefreshMarginMs,
      batchSize: options.publicUrlBatchSize,
    })
  }

  /** Get a lazy bucket handle. The backing Base is created on first operation. */
  bucket(name: string): R2Bucket {
    validateBucketName(name)
    let bucket = this.buckets.get(name)
    if (!bucket) {
      bucket = new R2Bucket({
        name,
        client: this.client,
        uploadMutex: this.uploadMutex,
        publicUrls: this.publicUrls,
        listScanLimit: this.listScanLimit,
      })
      this.buckets.set(name, bucket)
    }
    return bucket
  }

  /** Eagerly create (or adopt) a bucket and return its handle. */
  async createBucket(name: string): Promise<R2Bucket> {
    const bucket = this.bucket(name)
    await bucket.ensure()
    return bucket
  }

  /** Discover buckets by the `r2:` database-name prefix. */
  async listBuckets(): Promise<R2BucketInfo[]> {
    const databases = await this.client.listDatabases()
    const buckets: R2BucketInfo[] = []
    for (const database of databases) {
      if (!database.name.startsWith(BUCKET_PREFIX)) continue
      const name = database.name.slice(BUCKET_PREFIX.length)
      if (!isValidBucketName(name)) continue
      buckets.push({ name, baseToken: database.token })
    }
    return buckets
  }
}

export function createR2(options: R2Options): R2 {
  return new R2(options)
}
