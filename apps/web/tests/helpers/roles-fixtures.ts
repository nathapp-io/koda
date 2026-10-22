/**
 * Shared fixtures for the Admin -> Roles specs (Permissions P1 US-010): a catalog, two roles, and a
 * fake `$api` that answers `/roles` and `/permissions/catalog`. The real `useRoles` runs over it, so
 * a spec asserts the HTTP calls (`POST /roles`, `PATCH /roles/<id>`), not a composable double.
 */
import { settle } from './roles-dom'
import type { CatalogEntry, Role } from '../../composables/useRoles'

export const CATALOG: CatalogEntry[] = [
  { key: 'comment.update', scope: 'project', risk: 'medium', principals: ['user', 'agent'], ownable: true },
  { key: 'fleet.job.read', scope: 'any', risk: 'low', principals: ['user'], ownable: false },
  { key: 'role.manage', scope: 'global', risk: 'critical', principals: ['user'], ownable: false },
  { key: 'ticket.create', scope: 'project', risk: 'medium', principals: ['user', 'agent'], ownable: false },
  { key: 'ticket.delete', scope: 'project', risk: 'high', principals: ['user'], ownable: false },
  { key: 'ticket.read', scope: 'project', risk: 'low', principals: ['user', 'agent'], ownable: false },
  { key: 'user.read', scope: 'global', risk: 'low', principals: ['user'], ownable: false },
]

export function role(over: Partial<Role> = {}): Role {
  return {
    id: 'r1', key: 'qa', name: 'QA', description: 'Runs the QA pass', scope: 'PROJECT',
    system: false, locked: false, permissions: [], expandedKeys: [], ...over,
  }
}

export interface FakeApi {
  get: jest.Mock
  post: jest.Mock
  patch: jest.Mock
  delete: jest.Mock
}

export function fakeApi(roles: Role[], over: Partial<FakeApi> = {}): FakeApi {
  return {
    get: jest.fn(async (path: string) => (path === '/permissions/catalog' ? CATALOG : roles)),
    post: jest.fn(async (_path: string, body: Record<string, unknown>) => role({ id: 'new', ...body } as Partial<Role>)),
    patch: jest.fn(async (path: string, body: Record<string, unknown>) => role({ id: path.split('/').pop(), ...body } as Partial<Role>)),
    delete: jest.fn(async () => undefined),
    ...over,
  }
}

export { settle }
