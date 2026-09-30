export type Now = () => Date;
/** Resolves after `ms`, or early (never rejecting) when the signal aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const systemNow: Now = () => new Date();

export const systemSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
