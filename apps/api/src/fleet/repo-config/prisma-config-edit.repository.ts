import { Injectable } from '@nestjs/common';
import { FleetConfigEdit as Row, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ConfigEditMode, ConfigFileEdit, ConfigJobResult } from '../common/config-jobs';
import { ConfigEditRecord, IConfigEditRepository, NewConfigEdit } from './domain/config-edit.domain';

const toRecord = (r: Row): ConfigEditRecord => ({
  ...r,
  mode: r.mode as ConfigEditMode,
  edits: r.edits as unknown as ConfigFileEdit[],
  result: r.result as unknown as ConfigJobResult | null,
});

@Injectable()
export class PrismaConfigEditRepository implements IConfigEditRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async create(data: NewConfigEdit): Promise<ConfigEditRecord> {
    return toRecord(await this.db.fleetConfigEdit.create({ data: { ...data, edits: data.edits as unknown as Prisma.InputJsonValue } }));
  }

  async findByJobId(jobId: string): Promise<ConfigEditRecord | null> {
    const r = await this.db.fleetConfigEdit.findUnique({ where: { jobId } });
    return r ? toRecord(r) : null;
  }
}
