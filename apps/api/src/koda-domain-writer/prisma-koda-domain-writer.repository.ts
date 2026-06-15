import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaKodaDomainWriterRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async findProjectById(id: string): Promise<{ id: string } | null> {
    return this.prisma.client.project.findUnique({ where: { id }, select: { id: true } });
  }
}
