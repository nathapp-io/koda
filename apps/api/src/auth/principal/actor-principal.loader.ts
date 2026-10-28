import { Injectable } from '@nestjs/common';
import { currentContext } from '../../action-context/action-context';
import type { AgentPrincipal, UserPrincipal } from './koda-principal.types';
import { PrismaAuthRepository } from '../prisma-auth.repository';

export interface ActorReference {
  type: string;
  id: string;
}

export class ActorUnavailableError extends Error {
  readonly actor: ActorReference | null;

  constructor(actor: ActorReference | null) {
    super(actor === null ? 'actor unavailable' : `actor unavailable: ${actor.type}:${actor.id}`);
    this.name = 'ActorUnavailableError';
    this.actor = actor;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

@Injectable()
export class ActorPrincipalLoader {
  constructor(private readonly authRepository: PrismaAuthRepository) {}

  async load(actor: { type: 'USER' | 'AGENT'; id: string }): Promise<UserPrincipal | AgentPrincipal> {
    if (actor.type === 'USER') {
      const user = await this.authRepository.findUserById(actor.id);
      if (!user || user.disabled) throw new ActorUnavailableError(actor);
      const role = await this.authRepository.hasGlobalAdminBinding(actor.id) ? 'ADMIN' : 'MEMBER';
      return {
        actorType: 'user',
        id: user.id,
        name: user.email,
        email: user.email,
        role,
        blacklisted: false,
        revoked: false,
        authorities: [role],
        extra: { sub: user.id, email: user.email, role },
      };
    }

    const agent = await this.authRepository.findAgentById(actor.id);
    if (!agent || agent.status === 'PAUSED') throw new ActorUnavailableError(actor);
    return {
      actorType: 'agent',
      id: agent.id,
      name: agent.slug,
      slug: agent.slug,
      status: agent.status as AgentPrincipal['status'],
      capabilities: [],
      blacklisted: false,
      revoked: false,
      authorities: [],
      extra: { slug: agent.slug },
    };
  }

  async forContext(): Promise<UserPrincipal | AgentPrincipal> {
    const actor = currentContext()?.actor;
    if (!actor || (actor.type !== 'USER' && actor.type !== 'AGENT')) {
      throw new ActorUnavailableError(actor ? { type: actor.type, id: actor.id } : null);
    }
    return this.load({ type: actor.type, id: actor.id });
  }
}

