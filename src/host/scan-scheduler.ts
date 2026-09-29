import { setImmediate as yieldToHost } from 'node:timers/promises'

/** Disk logs contain CPU-heavy decompression/parsing; do not fan out 16 replays. */
export async function mapScanSessions<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  isCancelled: () => boolean = () => false,
): Promise<R[]> {
  const results: R[] = []
  for (const item of items) {
    if (isCancelled()) throw new Error('usage scan cancelled')
    results.push(await run(item))
    // Yield outside the microtask queue, including when all rows hit cache.
    await yieldToHost()
  }
  if (isCancelled()) throw new Error('usage scan cancelled')
  return results
}
