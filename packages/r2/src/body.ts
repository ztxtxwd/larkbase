import { ValidationError } from '@larkflare/db'
import type { R2Body } from './types.js'

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  )
}

async function concatIterable(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new ValidationError('AsyncIterable body must yield Uint8Array chunks')
    }
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  }
  return Buffer.concat(chunks)
}

/** Normalise every accepted body shape into one Buffer for upload. */
export async function readBody(body: R2Body): Promise<Buffer> {
  let bytes: Buffer
  if (typeof body === 'string') {
    bytes = Buffer.from(body, 'utf8')
  } else if (Buffer.isBuffer(body)) {
    bytes = body
  } else if (body instanceof ArrayBuffer) {
    bytes = Buffer.from(body)
  } else if (ArrayBuffer.isView(body)) {
    bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  } else if (body instanceof Blob) {
    bytes = Buffer.from(await body.arrayBuffer())
  } else if (isAsyncIterable(body)) {
    bytes = await concatIterable(body)
  } else {
    throw new ValidationError(
      'Unsupported body: expected Buffer, Uint8Array, ArrayBuffer, string, Blob or AsyncIterable<Uint8Array>',
    )
  }
  if (bytes.byteLength === 0) {
    throw new ValidationError(
      'Cannot store an empty object: Feishu Drive rejects zero-byte media uploads',
    )
  }
  return bytes
}
