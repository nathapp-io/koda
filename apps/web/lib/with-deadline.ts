/**
 * Settles with `promise`, or rejects once `ms` have passed without an answer. The timer is always
 * cleared, so a request that answers in time leaves nothing pending. The request itself is not
 * cancelled: a late answer is simply never read.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, message = 'The request timed out'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}
