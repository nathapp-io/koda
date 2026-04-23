import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

export interface ActorRequest {
  user?: { id: string; sub?: string; role?: string } | null;
  agent?: { id: string; sub?: string } | null;
}

export interface Actor {
  actorType: 'user' | 'agent';
  actorId: string;
  projectRoles: string[];
  resourceRoles: string[];
}

@Injectable()
export class ActorResolver {
  private readonly logger = new Logger(ActorResolver.name);

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async resolve(request: ActorRequest): Promise<Actor> {
    const user = request.user;
    const agent = request.agent;

    let actorType: 'user' | 'agent';
    let actorId: string;
    let userRole: string | undefined;

    if (user) {
      actorType = 'user';
      actorId = user.id || user.sub || '';
      userRole = user.role;
    } else if (agent) {
      actorType = 'agent';
      actorId = agent.id || agent.sub || '';
    } else {
      actorType = 'user' as const;
      actorId = '';
    }

    const roleEntries = await this.prisma.client.agentRoleEntry.findMany({
      where: { agentId: actorId },
    });

    let projectRoles = (roleEntries ?? []).map((e) => e.role);

    if (projectRoles.length === 0 && userRole) {
      projectRoles = [userRole];
    }

    if (projectRoles.length === 0) {
      this.logger.debug?.(`No agent role entries found for actor ${actorId} (type: ${actorType}). User actors rely on JWT role; agent actors should have agentRoleEntry records.`);
    }

    return {
      actorType,
      actorId,
      projectRoles,
      resourceRoles: [],
    };
  }
}