import type { RunnerIdentity } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import type { Logger } from '../logger';

/** The server owns capacity (#157); the runner only reads it. `freeSlots = capacity - active jobs` (design §1). */
export class CapacityTracker {
  private value: number | null = null;

  constructor(private readonly client: { me(signal?: AbortSignal): Promise<RunnerIdentity> }, private readonly log: Logger) {}

  get capacity(): number | null {
    return this.value;
  }

  async refresh(): Promise<void> {
    try {
      const { capacity } = await this.client.me();
      if (typeof capacity === 'number' && Number.isInteger(capacity) && capacity >= 0) this.value = capacity;
      else this.log.warn('server reported an unusable capacity', { capacity });
    } catch (error) {
      this.log.warn('could not read runner capacity', { error: errorMessage(error) });
    }
  }
}

export function freeSlots(capacity: number | null, active: number): number {
  if (capacity === null) return 0;
  return Math.min(64, Math.max(0, capacity - active));
}
