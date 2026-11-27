import { ValidationError } from '@larkflare/db'
import { KV_MAX_KEY_BYTES } from './types.js'

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_NAMESPACE_LENGTH = 100

/** A KV key is a non-empty UTF-8 string of at most 512 bytes. */
export function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') {
    throw new ValidationError('Key must be a string')
  }
  if (key.length === 0) {
    throw new ValidationError('Key must not be empty')
  }
  if (key === '.' || key === '..') {
    throw new ValidationError('Key must not be "." or ".."')
  }
  if (Buffer.byteLength(key, 'utf8') > KV_MAX_KEY_BYTES) {
    throw new ValidationError(`Key must be at most ${KV_MAX_KEY_BYTES} UTF-8 bytes`)
  }
}

/**
 * A namespace name is a non-empty string of at most 100 characters without C0
 * control characters or DEL. It becomes the `<namespace>` suffix of the
 * `kv:<namespace>` database name.
 */
export function validateNamespaceName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('Namespace name must be a non-empty string')
  }
  if (name.length > MAX_NAMESPACE_LENGTH) {
    throw new ValidationError(
      `Namespace name must be at most ${MAX_NAMESPACE_LENGTH} characters long`,
    )
  }
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      throw new ValidationError('Namespace name must not contain control characters')
    }
  }
}

/** Boolean form of {@link validateNamespaceName}, for filtering discovery results. */
export function isValidNamespaceName(name: string): boolean {
  try {
    validateNamespaceName(name)
    return true
  } catch {
    return false
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
    throw new ValidationError('cursor does not decode to a valid UTF-8 key')
  }
  validateKey(key)
  return key
}

/** FNV-1a over the key's UTF-8 bytes, folded into a mutex stripe index. */
export function stripeIndex(key: string, stripes: number): number {
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(key, 'utf8')) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % stripes
}
