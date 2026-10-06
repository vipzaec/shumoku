const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Keep display lists alphabetical without changing the source or saved order. */
export function sortByName<T>(items: readonly T[], name: (item: T) => string): T[] {
  return [...items].sort((left, right) => nameCollator.compare(name(left), name(right)))
}
