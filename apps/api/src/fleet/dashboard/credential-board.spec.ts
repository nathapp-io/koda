import { DASH_NOW, dashCaps } from '../../common/test-helpers/fleet-dashboard';
import type { RunnerCredential } from '../common/protocol';
import { BoardRunner, buildCredentialBoard, credentialCell, isExpiring } from './credential-board';

const DAY = 86_400_000;
const inDays = (d: number): string => new Date(DASH_NOW.getTime() + d * DAY).toISOString();
const oauth = (expires: string | undefined, expired = false): RunnerCredential => ({
  providerId: 'anthropic', available: true, stored: { kind: 'oauth', ...(expires ? { expires } : {}), expired }, ambient: false,
});
const board = (over: Partial<BoardRunner> = {}): BoardRunner => ({
  id: 'r1', name: 'wk-mac', enabled: true, online: true, capabilities: dashCaps(), ...over,
});

describe('isExpiring (S3 D473)', () => {
  it('is true for an unexpired OAuth credential inside the window, including the boundary and a past unflagged date', () => {
    expect(isExpiring(oauth(inDays(3)), DASH_NOW, 7)).toBe(true);
    expect(isExpiring(oauth(inDays(7)), DASH_NOW, 7)).toBe(true);
    expect(isExpiring(oauth(inDays(-1)), DASH_NOW, 7)).toBe(true);
  });

  it('is false outside the window, when already expired, undated, unparsable, or not OAuth', () => {
    expect(isExpiring(oauth(new Date(DASH_NOW.getTime() + 7 * DAY + 1000).toISOString()), DASH_NOW, 7)).toBe(false);
    expect(isExpiring(oauth(inDays(1), true), DASH_NOW, 7)).toBe(false);
    expect(isExpiring(oauth(undefined), DASH_NOW, 7)).toBe(false);
    expect(isExpiring(oauth('not-a-date'), DASH_NOW, 7)).toBe(false);
    expect(isExpiring({ providerId: 'k', available: true, stored: { kind: 'api-key', expires: inDays(1), expired: false }, ambient: false }, DASH_NOW, 7)).toBe(false);
  });
});

describe('credentialCell (S3 §4.4)', () => {
  it('orders missing > unavailable > expired > expiring > ok and reports the serving kind', () => {
    expect(credentialCell(undefined, DASH_NOW, 7)).toEqual({ state: 'missing', kind: 'none' });
    expect(credentialCell({ providerId: 'x', available: false, stored: null, exec: 'error', ambient: false }, DASH_NOW, 7))
      .toEqual({ state: 'unavailable', kind: 'exec' });
    expect(credentialCell(oauth(inDays(-2), true), DASH_NOW, 7)).toEqual({ state: 'expired', kind: 'oauth', expires: inDays(-2) });
    expect(credentialCell(oauth(inDays(2)), DASH_NOW, 7)).toEqual({ state: 'expiring', kind: 'oauth', expires: inDays(2) });
    expect(credentialCell(oauth(inDays(30)), DASH_NOW, 7)).toEqual({ state: 'ok', kind: 'oauth', expires: inDays(30) });
    expect(credentialCell({ providerId: 'x', available: true, stored: null, ambient: true }, DASH_NOW, 7)).toEqual({ state: 'ok', kind: 'ambient' });
  });
});

describe('buildCredentialBoard (S3 §4.4)', () => {
  it('builds a provider x runner grid over the union of reported and profile-named providers', () => {
    const a = board({
      id: 'a', name: 'a',
      capabilities: dashCaps({
        profiles: { fast: { protocol: 'native', providers: ['deepseek', 'openai'], sandbox: false } },
        credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }, oauth(inDays(2))],
      }),
    });
    const b = board({ id: 'b', name: 'b', online: false });
    const out = buildCredentialBoard([a, b], DASH_NOW, 7);
    expect(out.generatedAt).toBe(DASH_NOW.toISOString());
    expect(out.warnDays).toBe(7);
    expect(out.runners).toEqual([
      { id: 'a', name: 'a', enabled: true, online: true, readable: true },
      { id: 'b', name: 'b', enabled: true, online: false, readable: true },
    ]);
    expect(out.providers.map((p) => p.providerId)).toEqual(['anthropic', 'deepseek', 'openai']);
    const row = (id: string) => out.providers.find((p) => p.providerId === id)?.cells;
    expect(row('anthropic')).toEqual({ a: { state: 'expiring', kind: 'oauth', expires: inDays(2) }, b: { state: 'missing', kind: 'none' } });
    expect(row('openai')).toEqual({ a: { state: 'missing', kind: 'none' }, b: { state: 'missing', kind: 'none' } });
    expect(row('deepseek')?.b).toEqual({ state: 'ok', kind: 'api-key' });
  });

  it('lists a runner with unreadable capabilities without cells', () => {
    const out = buildCredentialBoard([board(), board({ id: 'x', name: 'x', capabilities: null })], DASH_NOW, 7);
    expect(out.runners.find((r) => r.id === 'x')).toEqual({ id: 'x', name: 'x', enabled: true, online: true, readable: false });
    expect(out.providers.every((p) => !('x' in p.cells))).toBe(true);
    expect(out.profiles.every((p) => !('x' in p.runners))).toBe(true);
  });

  it('builds the profile inventory with needs and the placement misfit', () => {
    const a = board({ id: 'a', name: 'a', capabilities: dashCaps({
      profiles: {
        fast: { protocol: 'native', providers: ['deepseek'], sandbox: false },
        boxed: { protocol: 'native', providers: ['deepseek'], sandbox: true },
      },
      sandbox: { available: false, probedAt: DASH_NOW.toISOString() },
    }) });
    const b = board({ id: 'b', name: 'b' });
    const out = buildCredentialBoard([a, b], DASH_NOW, 7);
    expect(out.profiles.map((p) => p.name)).toEqual(['boxed', 'fast']);
    expect(out.profiles[0].runners).toEqual({
      a: { present: true, needs: { protocol: 'native', providers: ['deepseek'], sandbox: true }, misfit: 'sandbox' },
      b: { present: false },
    });
    expect(out.profiles[1].runners.a).toEqual({ present: true, needs: { protocol: 'native', providers: ['deepseek'], sandbox: false } });
  });

  it('returns empty rows for no runners and does not mutate its input', () => {
    expect(buildCredentialBoard([], DASH_NOW, 7)).toEqual({ generatedAt: DASH_NOW.toISOString(), warnDays: 7, runners: [], providers: [], profiles: [] });
    const input = [board()];
    const snapshot = JSON.stringify(input);
    buildCredentialBoard(input, DASH_NOW, 7);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
