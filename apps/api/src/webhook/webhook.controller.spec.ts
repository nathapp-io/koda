import { PATH_METADATA } from '@nestjs/common/constants';
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
});
