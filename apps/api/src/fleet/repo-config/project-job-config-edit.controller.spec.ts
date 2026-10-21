/**
 * Permissions P1d (US-007): the job config-edit read declares `fleet.job.config.read`, so a rostered agent reads
 * what REST used to refuse it, checked after the membership guard. Metadata only: no database, no Nest app.
 */
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { REQUIRES_METADATA, type RequiresMetadata } from '../../permissions/requires.decorator';
import { ProjectJobConfigEditController } from './project-job-config-edit.controller';

describe('ProjectJobConfigEditController route keys (US-007)', () => {
  const handler = (): object => ProjectJobConfigEditController.prototype.get as unknown as object;

  it('get requires fleet.job.config.read, checked by RequiresGuard', () => {
    expect(Reflect.getMetadata(REQUIRES_METADATA, handler())).toEqual({
      keys: ['fleet.job.config.read'],
      mode: 'all',
      enforcedBy: 'guard',
    } satisfies RequiresMetadata);
  });

  it('get runs ProjectMembershipGuard before RequiresGuard', () => {
    const guards = (Reflect.getMetadata('__guards__', handler()) ?? []) as Array<{ name?: string }>;

    expect(guards.map((guard) => guard.name)).toEqual(['ProjectMembershipGuard', 'RequiresGuard']);
  });

  it('get carries no legacy decorator, so one mechanism decides it', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, handler())).toBeUndefined();
  });

  it('keeps the controller class free of a class-level key or membership guard', () => {
    expect(Reflect.getMetadata(REQUIRES_METADATA, ProjectJobConfigEditController)).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', ProjectJobConfigEditController)).toBeUndefined();
  });
});
