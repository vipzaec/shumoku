/** Keep full-layout writes in user order, even when network responses finish out of order. */
export function createSerialLayoutWriter<T>(write: (value: T) => Promise<unknown>) {
  let tail: Promise<void> = Promise.resolve()

  return {
    enqueue(value: T): Promise<void> {
      const next = tail.catch(() => undefined).then(() => write(value))
      tail = next.then(() => undefined)
      return tail
    },
    flush(): Promise<void> {
      return tail
    },
  }
}
