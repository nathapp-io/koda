import { Injectable } from '@nestjs/common';

/**
 * In-process long-poll wake-ups keyed by runner id (spec §3.2; single API instance).
 * `wait` registers before calling `ready()`, so a notify that lands between the
 * caller's last read and the wait still wakes it.
 */
@Injectable()
export class RunnerNotifier {
  private waiters: ReadonlyMap<string, ReadonlySet<() => void>> = new Map();

  notify(runnerId: string): void {
    for (const wake of this.waiters.get(runnerId) ?? []) wake();
  }

  waiterCount(runnerId: string): number {
    return this.waiters.get(runnerId)?.size ?? 0;
  }

  async wait(runnerId: string, ms: number, ready: () => Promise<boolean>): Promise<void> {
    if (ms <= 0) return;
    let wake: () => void = () => undefined;
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.add(runnerId, wake);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (await ready()) return;
      await Promise.race([woken, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    } finally {
      if (timer) clearTimeout(timer);
      this.remove(runnerId, wake);
    }
  }

  private add(runnerId: string, wake: () => void): void {
    this.waiters = new Map([...this.waiters, [runnerId, new Set([...(this.waiters.get(runnerId) ?? []), wake])]]);
  }

  private remove(runnerId: string, wake: () => void): void {
    const rest = [...(this.waiters.get(runnerId) ?? [])].filter((w) => w !== wake);
    const next = new Map(this.waiters);
    if (rest.length > 0) next.set(runnerId, new Set(rest));
    else next.delete(runnerId);
    this.waiters = next;
  }
}
