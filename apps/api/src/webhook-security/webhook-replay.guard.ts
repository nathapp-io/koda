import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient, Prisma } from '@prisma/client';

export type WebhookSource = 'github' | 'ci';

export interface ReplayCheckInput {
  projectId: string;
  source: WebhookSource;
  /** Sender-provided delivery id (`X-GitHub-Delivery` / `X-CI-Delivery`). */
  deliveryId?: string;
  /** RFC 7231 `Date` header, used as a best-effort freshness window. */
  dateHeader?: string;
}

const MAX_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const MAX_IN_MEMORY_ENTRIES = 10_000;

/**
 * Rejects replayed inbound webhooks (SEC-1).
 *
 * Every accepted delivery is recorded in `WebhookDelivery` keyed on
 * (projectId, source, deliveryId), so a replayed payload with the same
 * delivery id is rejected with HTTP 409 forever — even across instances
 * and after the in-memory fast-path window has expired.
 *
 * Callers must invoke `forget` when processing fails with a retriable
 * error, so legitimate sender retries (GitHub re-delivers with the same
 * `X-GitHub-Delivery` id) are not blocked permanently.
 */
@Injectable()
export class WebhookReplayGuard {
  private readonly logger = new Logger(WebhookReplayGuard.name);
  private readonly recentDeliveries = new Map<string, number>();

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async assertFresh(input: ReplayCheckInput): Promise<void> {
    const { projectId, source, deliveryId } = input;

    if (!deliveryId) {
      throw new HttpException('Missing webhook delivery id header', HttpStatus.BAD_REQUEST);
    }

    // Best-effort freshness window for naive replays (curl-style re-sends).
    // Headers are not covered by the body HMAC, so this is defense-in-depth;
    // the persistent delivery-id dedup below is the real protection.
    this.assertWithinWindow(input);

    const key = this.keyOf(input);
    const now = Date.now();

    const seenAt = this.recentDeliveries.get(key);
    if (seenAt !== undefined && now - seenAt < MAX_REPLAY_WINDOW_MS) {
      this.logger.warn(`Replaying webhook blocked (in-memory): ${key}`);
      throw this.conflict();
    }

    try {
      const existing = await this.prisma.client.webhookDelivery.findUnique({
        where: {
          projectId_source_deliveryId: { projectId, source, deliveryId },
        },
        select: { id: true },
      });
      if (existing) {
        this.logger.warn(`Replaying webhook blocked (persisted): ${key}`);
        throw this.conflict();
      }

      await this.prisma.client.webhookDelivery.create({
        data: { projectId, source, deliveryId },
      });
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      // BUG-16: only a unique-violation is a replay. Anything else (DB
      // outage, connection error, …) must surface as a retriable 5xx so the
      // sender retries with the same delivery id — masking it as 409 would
      // permanently drop a legitimate first-time delivery.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.warn(`Replaying webhook blocked (unique violation): ${key}`);
        throw this.conflict();
      }
      throw err;
    }

    this.remember(key, now);
  }

  /**
   * Remove a previously recorded delivery. Call after processing failed so
   * the sender's retry with the same delivery id is accepted.
   */
  async forget(input: ReplayCheckInput): Promise<void> {
    const { projectId, source, deliveryId } = input;
    if (!deliveryId) return;

    this.recentDeliveries.delete(this.keyOf(input));

    try {
      await this.prisma.client.webhookDelivery.deleteMany({
        where: { projectId, source, deliveryId },
      });
    } catch (err) {
      this.logger.warn(`Failed to forget webhook delivery ${projectId}:${source}:${deliveryId}`, err);
    }
  }

  private keyOf(input: ReplayCheckInput): string {
    return `${input.projectId}:${input.source}:${input.deliveryId ?? ''}`;
  }

  private assertWithinWindow(input: ReplayCheckInput): void {
    const { dateHeader } = input;
    if (!dateHeader) return;

    const sentAt = Date.parse(dateHeader);
    if (!Number.isFinite(sentAt)) {
      throw new HttpException('Invalid Date header on webhook', HttpStatus.BAD_REQUEST);
    }

    const skewMs = Date.now() - sentAt;
    if (Math.abs(skewMs) > MAX_REPLAY_WINDOW_MS) {
      this.logger.warn(`Webhook Date header outside replay window (skew ${skewMs}ms)`);
      throw new HttpException('Webhook is outside the accepted replay window', HttpStatus.BAD_REQUEST);
    }
  }

  private remember(key: string, now: number): void {
    // BUG-18: age-prune entries outside the replay window so the map only
    // holds live entries and never sits at the size cap permanently.
    for (const [entryKey, seenAt] of this.recentDeliveries) {
      if (now - seenAt >= MAX_REPLAY_WINDOW_MS) {
        this.recentDeliveries.delete(entryKey);
      }
    }
    this.recentDeliveries.set(key, now);
    if (this.recentDeliveries.size > MAX_IN_MEMORY_ENTRIES) {
      const oldest = this.recentDeliveries.keys().next().value;
      if (oldest !== undefined) {
        this.recentDeliveries.delete(oldest);
      }
    }
  }

  private conflict(): HttpException {
    return new HttpException('Webhook already processed', HttpStatus.CONFLICT);
  }
}