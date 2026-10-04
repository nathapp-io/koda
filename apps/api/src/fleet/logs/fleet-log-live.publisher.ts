import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { LiveFleetLogEvent } from '../../live/live-event';
import { ProjectEventBus } from '../../live/project-event-bus';
import type { LogStreamName } from './domain/fleet-job-log.domain';

export interface LogTouch {
  projectId: string;
  jobId: string;
  leaseEpoch: number;
  stream: LogStreamName;
  size: number;
  complete: boolean;
}

interface Slot {
  readonly timer: NodeJS.Timeout;
  readonly pending: LogTouch | null;
}

const WINDOW_MS = 1000;

/** Spec §2.3: at most one fleet_log per (job, epoch, stream) per second, trailing edge; immediate on final/cap/fallback. */
@Injectable()
export class FleetLogLivePublisher implements OnModuleDestroy {
  private slots: ReadonlyMap<string, Slot> = new Map();

  constructor(private readonly bus: ProjectEventBus) {}

  get pendingKeys(): number {
    return this.slots.size;
  }

  touch(input: LogTouch, immediate: boolean): void {
    const key = `${input.jobId}:${input.leaseEpoch}:${input.stream}`;
    const slot = this.slots.get(key);
    if (immediate) {
      if (slot) clearTimeout(slot.timer);
      this.setSlot(key, null);
      this.emit(input);
      return;
    }
    if (slot) {
      this.setSlot(key, { ...slot, pending: input });
      return;
    }
    this.emit(input);
    this.setSlot(key, { timer: this.arm(key), pending: null });
  }

  onModuleDestroy(): void {
    for (const slot of this.slots.values()) clearTimeout(slot.timer);
    this.slots = new Map();
  }

  private arm(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.flush(key), WINDOW_MS);
    timer.unref?.();
    return timer;
  }

  private flush(key: string): void {
    const slot = this.slots.get(key);
    if (!slot?.pending) {
      this.setSlot(key, null);
      return;
    }
    this.emit(slot.pending);
    this.setSlot(key, { timer: this.arm(key), pending: null });
  }

  private setSlot(key: string, slot: Slot | null): void {
    const next = new Map(this.slots);
    if (slot) next.set(key, slot);
    else next.delete(key);
    this.slots = next;
  }

  private emit(t: LogTouch): void {
    const event: LiveFleetLogEvent = {
      id: randomUUID(), type: 'fleet_log', projectId: t.projectId, jobId: t.jobId, leaseEpoch: t.leaseEpoch,
      stream: t.stream, size: t.size, complete: t.complete, at: new Date().toISOString(),
    };
    this.bus.publish(event);
  }
}
