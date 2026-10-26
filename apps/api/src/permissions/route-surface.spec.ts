/**
 * US-010 — the shared route label.
 *
 * One label function for the two readers of a route: the permission contract walker prints it in a
 * violation message, and `ActionContextInterceptor` uses it as the audit scope's surface, which the
 * coverage allowlist matches. A drift between the two would silence a route's check, so the label
 * lives in one place.
 */
import { Controller, Get, Post, Put } from '@nestjs/common';
import { routeSurface } from './route-surface';

@Controller('me')
class MeController {
  @Post('notifications/read-all')
  readAll(): void {}

  @Get()
  list(): void {}

  unRouted(): void {}
}

@Controller()
class PathlessController {
  @Post()
  create(): void {}

  @Put('lead/')
  lead(): void {}
}

@Controller('/slash/')
class SlashedController {
  @Get('/nested/')
  nested(): void {}
}

describe('routeSurface', () => {
  it('AC-1: labels a controller path and a handler path as METHOD /path', () => {
    expect(routeSurface(MeController, MeController.prototype.readAll)).toBe(
      'POST /me/notifications/read-all',
    );
  });

  it('AC-2: answers undefined for a method with no route decorator', () => {
    expect(routeSurface(MeController, MeController.prototype.unRouted)).toBeUndefined();
  });

  it('reads the method from the decorator, not from a fixed list', () => {
    expect(routeSurface(MeController, MeController.prototype.list)).toBe('GET /me');
  });

  it('joins a pathless controller and a pathless handler to /', () => {
    expect(routeSurface(PathlessController, PathlessController.prototype.create)).toBe('POST /');
  });

  it('does not duplicate separators at either end', () => {
    expect(routeSurface(PathlessController, PathlessController.prototype.lead)).toBe('PUT /lead');
    expect(routeSurface(SlashedController, SlashedController.prototype.nested)).toBe(
      'GET /slash/nested',
    );
  });
});
