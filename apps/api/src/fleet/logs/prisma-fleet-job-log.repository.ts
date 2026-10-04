import { Injectable } from '@nestjs/common';
import { FleetJobLog as LogRow, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { FleetJobLogRecord, IFleetJobLogRepository, LogSource, LogStreamName, LogStreamPatch } from './domain/fleet-job-log.domain';

const toRecord = (r: LogRow): FleetJobLogRecord => ({
  ...r,
  stream: r.stream as LogStreamName,
  source: r.source as LogSource,
  sizeBytes: Number(r.sizeBytes),
});

@Injectable()
export class PrismaFleetJobLogRepository implements IFleetJobLogRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findStream(jobId: string, leaseEpoch: number, stream: LogStreamName): Promise<FleetJobLogRecord | null> {
    const r = await this.db.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch, stream } } });
    return r ? toRecord(r) : null;
  }

  async listForAttempt(jobId: string, leaseEpoch: number): Promise<FleetJobLogRecord[]> {
    return (await this.db.fleetJobLog.findMany({ where: { jobId, leaseEpoch }, orderBy: { stream: 'asc' } })).map(toRecord);
  }

  async upsertStream(jobId: string, leaseEpoch: number, stream: LogStreamName, patch: LogStreamPatch): Promise<FleetJobLogRecord> {
    const data = {
      sizeBytes: BigInt(patch.sizeBytes),
      ...(patch.complete === undefined ? {} : { complete: patch.complete }),
      ...(patch.truncated === undefined ? {} : { truncated: patch.truncated }),
    };
    return toRecord(await this.db.fleetJobLog.upsert({
      where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch, stream } },
      create: { jobId, leaseEpoch, stream, ...data },
      update: data,
    }));
  }

  async completeFromBundle(jobId: string, leaseEpoch: number, stream: LogStreamName, r: { sizeBytes: number; truncated: boolean }): Promise<boolean> {
    const data = { sizeBytes: BigInt(r.sizeBytes), source: 'bundle', complete: !r.truncated, truncated: r.truncated };
    const existing = await this.db.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch, stream } } });
    if (!existing) {
      await this.db.fleetJobLog.create({ data: { jobId, leaseEpoch, stream, ...data } });
      return true;
    }
    const { count } = await this.db.fleetJobLog.updateMany({ where: { id: existing.id, complete: false, truncated: false }, data });
    return count === 1;
  }
}
