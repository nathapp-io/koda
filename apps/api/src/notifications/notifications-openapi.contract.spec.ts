import { readFileSync } from 'fs';
import { join } from 'path';

interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
}

const spec = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi.json'), 'utf-8')) as Spec;

describe('notifications OpenAPI contract (S4a §3)', () => {
  it('exposes the inbox, preferences and watch routes', () => {
    expect(Object.keys(spec.paths['/api/me/notifications'] ?? {})).toContain('get');
    expect(Object.keys(spec.paths['/api/me/notifications/unread-count'] ?? {})).toContain('get');
    expect(Object.keys(spec.paths['/api/me/notifications/{id}/read'] ?? {})).toContain('post');
    expect(Object.keys(spec.paths['/api/me/notifications/read-all'] ?? {})).toContain('post');
    expect(Object.keys(spec.paths['/api/me/notification-preferences'] ?? {}).sort()).toEqual(['get', 'put']);
    expect(Object.keys(spec.paths['/api/projects/{slug}/tickets/{ref}/watch'] ?? {}).sort()).toEqual(['delete', 'put']);
    expect(Object.keys(spec.paths['/api/projects/{slug}/tickets/{ref}/watchers'] ?? {})).toContain('get');
  });

  it('pins the NotificationDto fields the web and CLI read', () => {
    expect(Object.keys(spec.components.schemas['NotificationDto']?.properties ?? {}).sort()).toEqual(
      ['actorId', 'body', 'category', 'createdAt', 'id', 'kind', 'link', 'params', 'projectId', 'readAt', 'title'],
    );
  });

  it('keeps the SSE stream out of the spec', () => {
    expect(spec.paths['/api/me/events']).toBeUndefined();
  });
});
