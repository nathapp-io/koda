import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRES_METADATA } from '../permissions/requires.decorator';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { RequiresGuard } from '../permissions/requires.guard';
import { WebhookController } from './webhook.controller';

/**
 * Route-path contract for WebhookController.
 *
 * The app applies a global prefix ('api'), so handler paths must NOT include
 * a leading 'api/'. A leading 'api/' produces a double-prefixed route
 * (e.g. /api/api/webhooks/:id). See docs §6.
 */
describe('WebhookController route paths', () => {
  const pathOf = (method: keyof WebhookController): string =>
    Reflect.getMetadata(PATH_METADATA, WebhookController.prototype[method]) as string;

  it('registers create at projects/:slug/webhooks', () => {
    expect(pathOf('register')).toBe('projects/:slug/webhooks');
  });

  it('registers list at projects/:slug/webhooks', () => {
    expect(pathOf('list')).toBe('projects/:slug/webhooks');
  });

  it('registers delete at webhooks/:id (no leading api/ prefix)', () => {
    const path = pathOf('remove');
    expect(path).toBe('webhooks/:id');
    expect(path.startsWith('api/')).toBe(false);
  });

  it.each([
    ['register', 'webhook.create'],
    ['list', 'webhook.read'],
    ['update', 'webhook.update'],
    ['removeByProject', 'webhook.delete'],
  ] as const)('%s declares %s after project membership', (handler, key) => {
    const method = WebhookController.prototype[handler];
    expect(Reflect.getMetadata(REQUIRES_METADATA, method)).toMatchObject({ keys: [key] });
    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([
      ProjectMembershipGuard,
      RequiresGuard,
    ]);
  });

  it('declares global deletion key without project membership', () => {
    const method = WebhookController.prototype.remove;
    expect(Reflect.getMetadata(REQUIRES_METADATA, method)).toMatchObject({ keys: ['webhook.delete'] });
    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([RequiresGuard]);
  });
});
