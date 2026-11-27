import { LarkflareError } from '@larkflare/db'

/** Base error raised by the D1 layer. */
export class D1Error extends LarkflareError {}

/** A parse error, with a byte offset into the SQL text. */
export class D1SyntaxError extends D1Error {
  readonly position: number

  constructor(message: string, position: number) {
    super(`${message} (at offset ${position})`)
    this.position = position
  }
}
