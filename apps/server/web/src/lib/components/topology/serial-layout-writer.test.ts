import { describe, expect, it } from 'vitest'
import { createSerialLayoutWriter } from './serial-layout-writer'

describe('createSerialLayoutWriter', () => {
  it('persists rapid edits in their original order', async () => {
    const writes: string[] = []
    let releaseFirst: (() => void) | undefined
    let markFirstStarted: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const writer = createSerialLayoutWriter(async (value: string) => {
      writes.push(value)
      if (value === 'first') {
        markFirstStarted?.()
        await first
      }
    })

    const pendingFirst = writer.enqueue('first')
    const pendingSecond = writer.enqueue('second')
    await firstStarted
    expect(writes).toEqual(['first'])

    releaseFirst?.()
    await Promise.all([pendingFirst, pendingSecond, writer.flush()])
    expect(writes).toEqual(['first', 'second'])
  })

  it('continues after a failed write and reports that failure', async () => {
    const writes: string[] = []
    const writer = createSerialLayoutWriter(async (value: string) => {
      writes.push(value)
      if (value === 'first') throw new Error('offline')
    })

    const first = writer.enqueue('first')
    const second = writer.enqueue('second')
    await expect(first).rejects.toThrow('offline')
    await expect(second).resolves.toBeUndefined()
    expect(writes).toEqual(['first', 'second'])
  })
})
