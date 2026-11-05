// apps/runner/test/helpers/deadline.ts

/**
 * Awaits `promise`, failing with `message` instead of hanging the test when nothing arrives.
 *
 * A test that stalls is reported by bun as `(fail) <name> [5000.00ms]` with the reason printed *after* that line, so
 * anything reading the failure block above it — a reviewer's harness included — captures no message at all. Bounding
 * an await keeps the failure an ordinary error with a message of its own. Keep the bound under bun's 5 s default
 * timeout so this fires first.
 */
export async function within<T>(promise: Promise<T>, message: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${message}: nothing arrived within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
