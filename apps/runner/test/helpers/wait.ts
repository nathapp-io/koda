export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(opts.message ?? 'waitFor: condition not met in time');
    await Bun.sleep(opts.intervalMs ?? 25);
  }
}
