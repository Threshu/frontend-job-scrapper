// Concurrency-limited async map. Runs `mapper` over `items` with at most
// `concurrency` in flight at a time; returns results in input order.
//
// Used by scrapers that fetch a large number of detail pages from friendly
// APIs (NoFluffJobs, JustJoin) where serial fetching + sleep was dominating
// scrape time. Not for LinkedIn — its detail endpoint 429s under any real load.
export async function pMap<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await mapper(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}
