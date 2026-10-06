import { describe, expect, it } from 'vitest'
import { sortByName } from './sort'

describe('sortByName', () => {
  it('orders mixed-case names and numbered services without mutating their source order', () => {
    const source = [{ name: 'Service 10' }, { name: 'service 2' }, { name: 'Alpha' }]

    expect(sortByName(source, (item) => item.name).map((item) => item.name)).toEqual([
      'Alpha',
      'service 2',
      'Service 10',
    ])
    expect(source[0]?.name).toBe('Service 10')
  })
})
