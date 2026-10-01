/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Resolves when all have
 * settled; a rejected call does not stop the others (callers record their own errors).
 */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length))
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await fn(item).catch(() => undefined)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
}
