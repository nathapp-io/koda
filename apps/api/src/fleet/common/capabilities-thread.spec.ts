import { CapabilityValidationError, parseCapabilitiesCore } from './capabilities-core';

const valid = {
  nax: { version: '0.83.0', protocols: ['native', 'acp'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: { native: { protocol: 'native', providers: ['deepseek'], sandbox: true } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
};

/** Returns what parseCapabilitiesCore threw, so the assertion reads the error rather than the message text. */
function rejection(raw: unknown): unknown {
  try {
    parseCapabilitiesCore(raw);
  } catch (err) {
    return err;
  }
  throw new Error('expected parseCapabilitiesCore to throw');
}

const models = (count: number): string[] => Array.from({ length: count }, (_, i) => `model-${i}`);

describe('parseCapabilitiesCore threadBackends (US-001)', () => {
  it('US-001: keeps a valid threadBackends report', () => {
    const parsed = parseCapabilitiesCore({ ...valid, threadBackends: { native: ['deepseek-v3'], acp: ['claude'] } });
    expect(parsed.threadBackends).toEqual({ native: ['deepseek-v3'], acp: ['claude'] });
  });

  it('US-001: omits the threadBackends key when the report has none', () => {
    const parsed = parseCapabilitiesCore(valid);
    expect(parsed).not.toHaveProperty('threadBackends');
  });

  it('US-001: refuses 33 distinct native model ids (cap is 32)', () => {
    const err = rejection({ ...valid, threadBackends: { native: models(33), acp: [] } });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'threadBackends' });
  });

  it('US-001: accepts exactly 32 distinct native model ids (boundary)', () => {
    const parsed = parseCapabilitiesCore({ ...valid, threadBackends: { native: models(32), acp: [] } });
    expect(parsed.threadBackends?.native).toHaveLength(32);
  });

  it('US-001: refuses an acp agent outside claude and codex', () => {
    const err = rejection({ ...valid, threadBackends: { native: [], acp: ['gemini'] } });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'threadBackends' });
  });

  it('US-001: refuses a native model id with a space', () => {
    const err = rejection({ ...valid, threadBackends: { native: ['bad model'], acp: [] } });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'threadBackends' });
  });

  it('US-001: refuses a threadBackends object with an extra key', () => {
    const err = rejection({ ...valid, threadBackends: { native: [], acp: [], other: [] } });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'threadBackends' });
  });

  it('US-001: refuses duplicate native model ids', () => {
    const err = rejection({ ...valid, threadBackends: { native: ['m1', 'm1'], acp: [] } });
    expect(err).toMatchObject({ reason: 'threadBackends' });
  });

  it('US-001: refuses duplicate acp agents', () => {
    const err = rejection({ ...valid, threadBackends: { native: [], acp: ['claude', 'claude'] } });
    expect(err).toMatchObject({ reason: 'threadBackends' });
  });

  it('US-001: refuses a threadBackends object missing acp', () => {
    const err = rejection({ ...valid, threadBackends: { native: [] } });
    expect(err).toMatchObject({ reason: 'threadBackends' });
  });

  it('US-001: refuses a non-object threadBackends', () => {
    const err = rejection({ ...valid, threadBackends: ['claude'] });
    expect(err).toMatchObject({ reason: 'threadBackends' });
  });
});
