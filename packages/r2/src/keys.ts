import { ValidationError } from '@larkflare/db'

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/
const IP_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_KEY_BYTES = 1024

/** S3-style bucket name: 3-63 lowercase letters, digits, dots and hyphens. */
export function validateBucketName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('Bucket name must be a non-empty string')
  }
  if (name.length < 3 || name.length > 63) {
    throw new ValidationError('Bucket name must be between 3 and 63 characters long')
  }
  if (!/^[a-z0-9.-]+$/.test(name)) {
    throw new ValidationError(
      'Bucket name may only contain lowercase letters, digits, dots and hyphens',
    )
  }
  if (!BUCKET_PATTERN.test(name)) {
    throw new ValidationError('Bucket name must start and end with a letter or digit')
  }
  if (name.includes('..')) {
    throw new ValidationError('Bucket name must not contain two consecutive dots')
  }
  if (IP_LIKE.test(name)) {
    throw new ValidationError('Bucket name must not look like an IPv4 address')
  }
}

/** Boolean form of {@link validateBucketName}, for filtering discovery results. */
export function isValidBucketName(name: string): boolean {
  try {
    validateBucketName(name)
    return true
  } catch {
    return false
  }
}

/**
 * Object keys are opaque: leading slashes and arbitrary Unicode are preserved.
 * Only C0 control characters and DEL are rejected.
 */
export function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') {
    throw new ValidationError('Object key must be a string')
  }
  if (key.length === 0) {
    throw new ValidationError('Object key must not be empty')
  }
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      throw new ValidationError('Object key must not contain control characters')
    }
  }
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
    throw new ValidationError(`Object key must be at most ${MAX_KEY_BYTES} UTF-8 bytes`)
  }
}

/** Opaque base64url cursor holding the last emitted key. */
export function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: unknown): string {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new ValidationError('cursor must be a non-empty string')
  }
  if (!CURSOR_PATTERN.test(cursor)) {
    throw new ValidationError('cursor must be base64url without padding')
  }
  const bytes = Buffer.from(cursor, 'base64url')
  if (bytes.length === 0 || bytes.toString('base64url') !== cursor) {
    throw new ValidationError('cursor is not canonical base64url')
  }
  const key = bytes.toString('utf8')
  if (!Buffer.from(key, 'utf8').equals(bytes)) {
    throw new ValidationError('cursor does not decode to a valid UTF-8 object key')
  }
  validateKey(key)
  return key
}
