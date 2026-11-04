import { KODA_TOOL_LIMITS } from '@nathapp/fleet-protocol';
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

/** One ACP discovery offer as the runner reports it; `over` makes a single field malformed. */
const offer = (over: Record<string, unknown> = {}) => ({
  agent: 'cursor', launchable: true, loggedIn: true, models: ['gpt-5.5[context=272k,reasoning=medium]'], efforts: ['high'], ...over,
});

/** Parses a report whose threadBackends carries `acpOffers`, and answers the parsed backends. */
const parsedWith = (acpOffers: unknown, over: Record<string, unknown> = {}) =>
  parseCapabilitiesCore({ ...valid, threadBackends: { native: ['m1'], acp: ['cursor'], acpOffers, ...over } }).threadBackends;

describe('parseCapabilitiesCore ACP agents on threadBackends (thread-agents-modes US-001)', () => {
  it('AC-1: keeps acp: [cursor]', () => {
    const parsed = parseCapabilitiesCore({ ...valid, threadBackends: { native: [], acp: ['cursor'] } });
    expect(parsed.threadBackends).toEqual({ native: [], acp: ['cursor'] });
  });

  it('AC-2: refuses acp: [gemini] with the same refusal as any unknown agent', () => {
    const unknownAgent = rejection({ ...valid, threadBackends: { native: [], acp: ['not-an-agent'] } });
    const gemini = rejection({ ...valid, threadBackends: { native: [], acp: ['gemini'] } });
    expect(gemini).toBeInstanceOf(CapabilityValidationError);
    expect(gemini).toMatchObject({ reason: 'threadBackends' });
    expect(gemini).toEqual(unknownAgent);
  });

  it('AC-3: keeps a valid acpOffers list unchanged', () => {
    const acpOffers = [offer()];
    const parsed = parseCapabilitiesCore({ ...valid, threadBackends: { native: ['m1'], acp: ['cursor'], acpOffers } });
    expect(parsed.threadBackends).toEqual({ native: ['m1'], acp: ['cursor'], acpOffers });
  });

  it('AC-4: drops acpOffers whose models hold an invalid id, keeping native and acp', () => {
    const backends = parsedWith([offer({ models: ['bad model!'] })]);
    expect(backends).toEqual({ native: ['m1'], acp: ['cursor'] });
    expect(backends).not.toHaveProperty('acpOffers');
  });

  it('AC-5: drops acpOffers that name the same agent twice', () => {
    const backends = parsedWith([offer(), offer({ launchable: false, loggedIn: null })]);
    expect(backends).toEqual({ native: ['m1'], acp: ['cursor'] });
    expect(backends).not.toHaveProperty('acpOffers');
  });

  it('AC-6: still refuses a threadBackends object with an extra key', () => {
    const err = rejection({ ...valid, threadBackends: { native: [], acp: [], other: [] } });
    expect(err).toMatchObject({ reason: 'threadBackends' });
    // A valid offer list does not make an unknown sibling key acceptable: the object stays strict.
    const withExtra = rejection({ ...valid, threadBackends: { native: [], acp: [], acpOffers: [offer()], extra: 1 } });
    expect(withExtra).toMatchObject({ reason: 'threadBackends' });
  });

  it('keeps an offer whose loggedIn is null (not probed, or the probe failed)', () => {
    expect(parsedWith([offer({ loggedIn: null })])?.acpOffers).toEqual([offer({ loggedIn: null })]);
  });

  it('keeps a launchable but not-logged-in agent that is absent from acp', () => {
    const backends = parsedWith([offer({ agent: 'claude', loggedIn: false, models: [], efforts: [] })], { acp: ['cursor'] });
    expect(backends?.acp).toEqual(['cursor']);
    expect(backends?.acpOffers).toEqual([{ agent: 'claude', launchable: true, loggedIn: false, models: [], efforts: [] }]);
  });

  it.each([
    ['loggedIn missing', offer({ loggedIn: undefined })],
    ['loggedIn a string', offer({ loggedIn: 'yes' })],
    ['launchable a string', offer({ launchable: 'yes' })],
    ['agent gemini', offer({ agent: 'gemini' })],
    ['models missing', offer({ models: undefined })],
    ['models not an array', offer({ models: 'gpt-5.5' })],
    ['33 model ids', offer({ models: models(33) })],
    ['efforts missing', offer({ efforts: undefined })],
    ['effort with a space', offer({ efforts: ['high effort'] })],
    ['effort longer than 32 characters', offer({ efforts: ['a'.repeat(33)] })],
    ['9 efforts', offer({ efforts: Array.from({ length: 9 }, (_, i) => `e${i}`) })],
    ['an extra key', { ...offer(), secret: true }],
  ])('drops acpOffers when an entry has %s', (_name, entry) => {
    const backends = parsedWith([entry]);
    expect(backends).toEqual({ native: ['m1'], acp: ['cursor'] });
  });

  it('drops acpOffers that is not an array or holds more than 8 entries', () => {
    expect(parsedWith('[not-an-array]')).toEqual({ native: ['m1'], acp: ['cursor'] });
    const nine = Array.from({ length: 9 }, (_, i) => offer({ agent: 'cursor', models: [`m${i}`] }));
    expect(parsedWith(nine)).toEqual({ native: ['m1'], acp: ['cursor'] });
  });

  it('keeps one offer per agent and 32 model ids per offer', () => {
    // The agent set is three, so a valid list is at most three offers long whatever the array cap says.
    const three = ['claude', 'codex', 'cursor'].map((agent) => offer({ agent }));
    expect(parsedWith(three)?.acpOffers).toHaveLength(3);
    expect(parsedWith([offer({ models: models(32) })])?.acpOffers?.[0].models).toHaveLength(32);
  });

  it('omits acpOffers when the report has none', () => {
    expect(parsedWith(undefined)).toEqual({ native: ['m1'], acp: ['cursor'] });
  });
});

describe('parseCapabilitiesCore workspaceThreads (US-001 AC-3-AC-5)', () => {
  it('AC-3: keeps workspaceThreads: true', () => {
    const parsed = parseCapabilitiesCore({ ...valid, workspaceThreads: true });
    expect(parsed.workspaceThreads).toBe(true);
  });

  it('AC-4: omits the workspaceThreads key when the report has none', () => {
    const parsed = parseCapabilitiesCore({ ...valid, projectThreads: true });
    expect(parsed).not.toHaveProperty('workspaceThreads');
    // Positive control: the same report with the flag set does carry the key, so the absence above is a real
    // absence and not a parser that never emits it.
    expect(parseCapabilitiesCore({ ...valid, workspaceThreads: true })).toHaveProperty('workspaceThreads', true);
  });

  it("AC-5: refuses workspaceThreads: 'yes' with reason workspaceThreads", () => {
    const err = rejection({ ...valid, workspaceThreads: 'yes' });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'workspaceThreads' });
  });

  it('AC-5: refuses workspaceThreads: false with reason workspaceThreads', () => {
    const err = rejection({ ...valid, workspaceThreads: false });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'workspaceThreads' });
  });
});

describe('parseCapabilitiesCore projectThreads (US-001 AC2-AC4)', () => {
  it('US-001 AC2: keeps projectThreads: true', () => {
    const parsed = parseCapabilitiesCore({ ...valid, projectThreads: true });
    expect(parsed.projectThreads).toBe(true);
  });

  it('US-001 AC3: omits the projectThreads key when the report has none', () => {
    const parsed = parseCapabilitiesCore({ ...valid, threadWrite: true });
    expect(parsed).not.toHaveProperty('projectThreads');
    expect(Object.keys(parsed).sort()).toEqual(['credentials', 'executors', 'nax', 'profiles', 'sandbox', 'threadWrite', 'tools']);
  });

  it('US-001 AC4: refuses projectThreads: false with reason projectThreads', () => {
    const err = rejection({ ...valid, projectThreads: false });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'projectThreads' });
  });

  it("US-001 AC4: refuses projectThreads: 'yes' with reason projectThreads", () => {
    const err = rejection({ ...valid, projectThreads: 'yes' });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'projectThreads' });
  });
});

describe('parseCapabilitiesCore projectCode (US-001 AC2-AC4)', () => {
  it('US-001 AC2: keeps projectCode: true', () => {
    const parsed = parseCapabilitiesCore({ ...valid, projectCode: true });
    expect(parsed.projectCode).toBe(true);
  });

  it('US-001 AC3: omits the projectCode key when the report has none', () => {
    const parsed = parseCapabilitiesCore({ ...valid, kodaTools: true });
    expect(parsed).not.toHaveProperty('projectCode');
    // Positive control: the same report with the flag set does carry the key, so the
    // absence above is a real absence and not a parser that never emits it.
    expect(parseCapabilitiesCore({ ...valid, projectCode: true })).toHaveProperty('projectCode', true);
  });

  it('US-001 AC4: refuses projectCode: false with reason projectCode', () => {
    const err = rejection({ ...valid, projectCode: false });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'projectCode' });
  });

  it("US-001 AC4: refuses projectCode: 'yes' with reason projectCode", () => {
    const err = rejection({ ...valid, projectCode: 'yes' });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'projectCode' });
  });
});

describe('parseCapabilitiesCore kodaTools (US-001 AC1-AC3)', () => {
  it('US-001 AC1: keeps kodaTools: true', () => {
    const parsed = parseCapabilitiesCore({ ...valid, kodaTools: true });
    expect(parsed.kodaTools).toBe(true);
  });

  it('US-001 AC2: omits the kodaTools key when the report has none', () => {
    const parsed = parseCapabilitiesCore({ ...valid, projectThreads: true });
    expect(parsed).not.toHaveProperty('kodaTools');
  });

  it('US-001 AC3: refuses kodaTools: false with reason kodaTools', () => {
    const err = rejection({ ...valid, kodaTools: false });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'kodaTools' });
  });

  it("US-001 AC3: refuses kodaTools: 'yes' with reason kodaTools", () => {
    const err = rejection({ ...valid, kodaTools: 'yes' });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'kodaTools' });
  });
});

describe('KODA_TOOL_LIMITS (US-001 AC4)', () => {
  it('US-001 AC4: nameRe accepts koda_get_ticket and rejects get_ticket', () => {
    expect(KODA_TOOL_LIMITS.nameRe.test('koda_get_ticket')).toBe(true);
    expect(KODA_TOOL_LIMITS.nameRe.test('get_ticket')).toBe(false);
  });
});

describe('parseCapabilitiesCore threadWrite (US-001 AC3-AC6)', () => {
  it('US-001 AC3: keeps threadWrite: true', () => {
    const parsed = parseCapabilitiesCore({ ...valid, threadWrite: true });
    expect(parsed.threadWrite).toBe(true);
  });

  it('US-001 AC4: omits the threadWrite key when the report has none', () => {
    const parsed = parseCapabilitiesCore(valid);
    expect(parsed).not.toHaveProperty('threadWrite');
  });

  it('US-001 AC5: refuses threadWrite: false with reason threadWrite', () => {
    const err = rejection({ ...valid, threadWrite: false });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'threadWrite' });
  });

  it("US-001 AC6: refuses threadWrite: 'yes' with reason threadWrite", () => {
    const err = rejection({ ...valid, threadWrite: 'yes' });
    expect(err).toBeInstanceOf(CapabilityValidationError);
    expect(err).toMatchObject({ reason: 'threadWrite' });
  });
});
