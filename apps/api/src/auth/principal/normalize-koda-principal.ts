import { KodaPrincipal, KodaUserRole } from './koda-principal.types';
import { ValidationAppException } from '@nathapp/nestjs-common';

export type LegacyPrincipal = {
  id?: string;
  sub?: string;
  name?: string;
  role?: string;
  authorities?: unknown[];
  extra?: {
    sub?: string;
    role?: string;
    email?: string;
    slug?: string;
    actorType?: 'user' | 'agent';
  };
};

const resolveUserRole = (role: unknown): KodaUserRole => {
  const normalized = String(role ?? 'MEMBER').toUpperCase();
  return normalized === 'ADMIN' ? 'ADMIN' : 'MEMBER';
};

export const normalizeKodaPrincipal = (
  principal: KodaPrincipal | LegacyPrincipal,
  actorType?: 'user' | 'agent',
): KodaPrincipal => {
  if ('actorType' in principal && (principal.actorType === 'user' || principal.actorType === 'agent')) {
    return principal;
  }

  const inferredActorType =
    actorType
    ?? principal.extra?.actorType
    ?? (principal.role || principal.extra?.role ? 'user' : undefined)
    ?? (principal.authorities?.length || principal.extra?.slug ? 'agent' : undefined);

  if (!inferredActorType) {
    throw new ValidationAppException({}, 'auth');
  }

  const resolvedActorType = inferredActorType;
  const id = principal.id ?? principal.sub ?? principal.extra?.sub ?? '';

  if (!id) {
    throw new ValidationAppException({}, 'auth');
  }

  if (resolvedActorType === 'agent') {
    const agentRoles = (principal.authorities ?? []).map((authority) => String(authority));
    return {
      actorType: 'agent',
      id,
      name: principal.name ?? principal.extra?.slug ?? id,
      slug: principal.extra?.slug ?? principal.name ?? id,
      status: 'ACTIVE',
      agentRoles,
      capabilities: [],
      blacklisted: false,
      revoked: false,
      authorities: agentRoles,
    };
  }

  const role = resolveUserRole(principal.role ?? principal.extra?.role);
  return {
    actorType: 'user',
    id,
    name: principal.name ?? principal.extra?.email ?? id,
    email: principal.extra?.email ?? id,
    role,
    blacklisted: false,
    revoked: false,
    authorities: [role],
    extra: {
      sub: id,
    },
  };
};