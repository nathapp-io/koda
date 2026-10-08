import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../generated/prisma/client';
import { ProjectInviteRecord } from './domain/project-invite.domain';

/**
 * Fleet S4b US-004 test-writer stub (RED state).
 *
 * Module-private persistence for `ProjectInvite`; the implementer owns the real
 * reads and writes (cancel-then-create, single-use accept, rotation, list).
 */
@Injectable()
export class PrismaProjectInvitesRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async cancelPending(_projectId: string, _email: string): Promise<number> {
    throw new Error('PrismaProjectInvitesRepository.cancelPending is not implemented');
  }

  async create(_input: {
    projectId: string;
    email: string;
    role: string;
    tokenHash: string;
    invitedById: string;
    expiresAt: Date;
  }): Promise<ProjectInviteRecord> {
    throw new Error('PrismaProjectInvitesRepository.create is not implemented');
  }

  async list(_projectId: string): Promise<ProjectInviteRecord[]> {
    throw new Error('PrismaProjectInvitesRepository.list is not implemented');
  }

  async findById(_projectId: string, _id: string): Promise<ProjectInviteRecord | null> {
    throw new Error('PrismaProjectInvitesRepository.findById is not implemented');
  }

  async rotate(_id: string, _tokenHash: string, _expiresAt: Date): Promise<ProjectInviteRecord> {
    throw new Error('PrismaProjectInvitesRepository.rotate is not implemented');
  }

  async cancel(_projectId: string, _id: string): Promise<void> {
    throw new Error('PrismaProjectInvitesRepository.cancel is not implemented');
  }
}
