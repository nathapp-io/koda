import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListRoleBindingsQuery } from './role-binding.dto';

const errorsOf = async (raw: object): Promise<string[]> =>
  (await validate(plainToInstance(ListRoleBindingsQuery, raw))).map((error) => error.property);

/**
 * US-002: the `GET /role-bindings` filter grammar, at the DTO level.
 *
 * The same rules are asserted over HTTP in
 * `test/integration/permissions/role-bindings-filters.integration.spec.ts`; this spec is the fast
 * unit-level statement of which query shapes are accepted, and of the one rule that is deliberately
 * *not* a DTO rule (`scope=global` with a `projectId` is the controller's `permissions.scopeAndProject`).
 */
describe('ListRoleBindingsQuery', () => {
  it('accepts no filter at all', async () => {
    expect(await errorsOf({})).toEqual([]);
  });

  it('accepts principalType alone, so a type can be listed without an id', async () => {
    expect(await errorsOf({ principalType: 'AGENT' })).toEqual([]);
    expect(await errorsOf({ principalType: 'USER' })).toEqual([]);
  });

  it('accepts a principalType with its principalId', async () => {
    expect(await errorsOf({ principalType: 'USER', principalId: 'u1' })).toEqual([]);
  });

  it('refuses a lone principalId', async () => {
    expect(await errorsOf({ principalId: 'u1' })).toContain('principalType');
  });

  it('refuses a principal type outside USER | AGENT', async () => {
    expect(await errorsOf({ principalType: 'RUNNER' })).toContain('principalType');
  });

  it('accepts scope=global and refuses every other scope', async () => {
    expect(await errorsOf({ scope: 'global' })).toEqual([]);
    expect(await errorsOf({ scope: 'project' })).toContain('scope');
    expect(await errorsOf({ scope: 'GLOBAL' })).toContain('scope');
  });

  it('leaves the scope/project conflict to the controller', async () => {
    // The DTO cannot know the sentence the client maps to, and `permissions.scopeAndProject` is an
    // app exception, not a field message: the controller refuses the combination.
    expect(await errorsOf({ scope: 'global', projectId: 'p1' })).toEqual([]);
  });

  it('accepts a projectId alone and the page parameters', async () => {
    expect(await errorsOf({ projectId: 'p1' })).toEqual([]);
    expect(await errorsOf({ current: 2, size: 200 })).toEqual([]);
    expect(await errorsOf({ size: 201 })).toContain('size');
  });
});
