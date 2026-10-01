import { isRunnerOnline } from './runner-online';

describe('isRunnerOnline', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000);

  it('is online up to and including the threshold (the placement rule)', () => {
    expect(isRunnerOnline(ago(0), now, 90)).toBe(true);
    expect(isRunnerOnline(ago(90), now, 90)).toBe(true);
  });

  it('is offline one millisecond past the threshold', () => {
    expect(isRunnerOnline(new Date(ago(90).getTime() - 1), now, 90)).toBe(false);
  });

  it('treats a lastSeenAt in the future (clock skew) as online', () => {
    expect(isRunnerOnline(new Date(now.getTime() + 5_000), now, 90)).toBe(true);
  });
});
