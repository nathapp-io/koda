import { Injectable } from '@nestjs/common';

/** Per-user count of open live streams (single API instance, in memory). */
@Injectable()
export class LiveStreamRegistry {
  private counts: ReadonlyMap<string, number> = new Map();

  tryAcquire(userId: string, limit: number): boolean {
    const current = this.activeFor(userId);
    if (current >= limit) return false;
    this.counts = new Map([...this.counts, [userId, current + 1]]);
    return true;
  }

  release(userId: string): void {
    const current = this.activeFor(userId);
    const next = new Map(this.counts);
    if (current <= 1) next.delete(userId);
    else next.set(userId, current - 1);
    this.counts = next;
  }

  activeFor(userId: string): number {
    return this.counts.get(userId) ?? 0;
  }
}
