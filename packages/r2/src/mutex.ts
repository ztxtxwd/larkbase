/**
 * Serialises asynchronous work on one shared queue. Feishu requires media
 * upload prepare/part/finish calls to run without overlap.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }
}
