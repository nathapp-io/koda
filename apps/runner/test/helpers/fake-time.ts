/** A clock the test moves: sleeping advances it and yields one macrotask, so loops make progress deterministically. */
export function fakeTime(startMs: number = Date.parse('2026-10-01T00:00:00.000Z')) {
  let t = startMs;
  return {
    now: (): Date => new Date(t),
    nowMs: (): number => t,
    sleep: async (ms: number): Promise<void> => {
      t += ms;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    advance: (ms: number): void => { t += ms; },
  };
}
