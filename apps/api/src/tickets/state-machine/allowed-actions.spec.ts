import { allowedActions, canOverrideClose, TICKET_ACTIONS } from './allowed-actions';
import type { TicketAction } from './allowed-actions';
import { TRANSITION_RULES, validateTransition } from './ticket-transitions';
import { TicketStatus, CommentType } from '../../common/enums';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';

const user = (over: Partial<UserPrincipal> = {}): UserPrincipal => ({
  actorType: 'user', id: 'u1', name: 'u1', email: 'u1@x', role: 'MEMBER',
  blacklisted: false, revoked: false, authorities: ['MEMBER'], ...over,
});
const agent: AgentPrincipal = {
  actorType: 'agent', id: 'a1', name: 'bot', slug: 'bot', status: 'ACTIVE',
  agentRoles: ['DEVELOPER', 'REVIEWER', 'VERIFIER', 'TRIAGER'], capabilities: [],
  blacklisted: false, revoked: false, authorities: ['WORKER'],
};

describe('canOverrideClose', () => {
  it.each([
    ['global ADMIN', user({ role: 'ADMIN' }), true],
    ['project ADMIN', user({ projectRole: 'ADMIN' }), true],
    ['project DEVELOPER', user({ projectRole: 'DEVELOPER' }), false],
    ['project VIEWER', user({ projectRole: 'VIEWER' }), false],
    ['no project role', user(), false],
    ['agent with every role', agent, false],
  ])('%s -> %s', (_label, principal, expected) => {
    expect(canOverrideClose(principal)).toBe(expected);
  });
});

/** What each endpoint asks the state machine for, from a given status. */
const ENDPOINT_TARGETS: Record<Exclude<typeof TICKET_ACTIONS[number], 'close'>, Array<[TicketStatus, CommentType | undefined]>> = {
  verify: [[TicketStatus.VERIFIED, CommentType.VERIFICATION]],
  start: [[TicketStatus.IN_PROGRESS, undefined]],
  fix: [[TicketStatus.VERIFY_FIX, CommentType.FIX_REPORT]],
  'verify-fix': [[TicketStatus.CLOSED, CommentType.REVIEW], [TicketStatus.IN_PROGRESS, CommentType.REVIEW]],
  reject: [[TicketStatus.REJECTED, CommentType.GENERAL]],
};
const CLOSE_SOURCES: readonly TicketStatus[] = [TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED, TicketStatus.VERIFY_FIX];
const ALL_STATUSES = Object.values(TicketStatus) as TicketStatus[];
// Strict: validateTransition would also accept a 'NONE' rule with a comment type attached.
const passes = (from: TicketStatus, to: TicketStatus, c?: CommentType) => {
  try { validateTransition(from, to, c); } catch { return false; }
  const required = TRANSITION_RULES[from]?.[to];
  return required === 'NONE' ? c === undefined : c === required;
};

describe('allowedActions', () => {
  /** Every action the state machine has, i.e. a caller holding every `TICKET_ACTION_KEYS` entry. */
  const EVERY_ACTION: ReadonlySet<TicketAction> = new Set(TICKET_ACTIONS);
  /** A developer: every transition key, never `ticket.transition.close` in the old model. */
  const TRANSITIONS_ONLY: ReadonlySet<TicketAction> = new Set(
    TICKET_ACTIONS.filter((action) => action !== 'close'),
  );
  /** A viewer: no ticket action key at all. */
  const NO_ACTIONS: ReadonlySet<TicketAction> = new Set();

  const callers = [
    ['every key', EVERY_ACTION],
    ['transition keys only', TRANSITIONS_ONLY],
    ['no action key', NO_ACTIONS],
  ] as const;

  describe.each(callers)('%s', (_label, permitted) => {
    it.each(ALL_STATUSES)('from %s: every action offered passes validateTransition', (status) => {
      for (const action of allowedActions(status, permitted)) {
        if (action === 'close') {
          expect(CLOSE_SOURCES).toContain(status);
          continue;
        }
        expect(ENDPOINT_TARGETS[action].some(([to, c]) => passes(status, to, c))).toBe(true);
      }
    });

    it.each(ALL_STATUSES)('from %s: offers only permitted actions', (status) => {
      const actions = allowedActions(status, permitted);
      // The permitted set filters: an action nobody holds a key for is never offered.
      for (const action of actions) expect(permitted.has(action)).toBe(true);
      expect(actions.includes('close')).toBe(permitted.has('close') && CLOSE_SOURCES.includes(status));
      if (!permitted.has('close')) expect(actions).not.toContain('close');
    });
  });

  it('covers every reachable rule in TRANSITION_RULES for a caller holding every key', () => {
    for (const [from, targets] of Object.entries(TRANSITION_RULES) as Array<[TicketStatus, Record<string, unknown>]>) {
      for (const to of Object.keys(targets) as TicketStatus[]) {
        // IN_PROGRESS -> VERIFIED needs a GENERAL comment no route supplies: unreachable by design.
        if (from === TicketStatus.IN_PROGRESS && to === TicketStatus.VERIFIED) continue;
        const actions = allowedActions(from, EVERY_ACTION).filter((a): a is keyof typeof ENDPOINT_TARGETS => a !== 'close');
        expect({ from, to, covered: actions.some((a) => ENDPOINT_TARGETS[a].some(([t]) => t === to)) })
          .toEqual({ from, to, covered: true });
      }
    }
  });

  it('terminal statuses offer nothing, even to a caller holding every key', () => {
    expect(allowedActions(TicketStatus.CLOSED, EVERY_ACTION)).toEqual([]);
    expect(allowedActions(TicketStatus.REJECTED, EVERY_ACTION)).toEqual([]);
  });

  it('never offers verify-fix outside VERIFY_FIX (regression: NONE rules ignore the comment type)', () => {
    for (const status of [TicketStatus.CREATED, TicketStatus.VERIFIED, TicketStatus.IN_PROGRESS]) {
      expect(allowedActions(status, EVERY_ACTION)).not.toContain('verify-fix');
    }
  });

  it('keeps a stable order for rendering', () => {
    expect(allowedActions(TicketStatus.CREATED, EVERY_ACTION)).toEqual(['verify', 'start', 'reject']);
    expect(allowedActions(TicketStatus.VERIFY_FIX, EVERY_ACTION)).toEqual(['verify-fix', 'close']);
  });

  // AC-17: the permitted set filters the status-valid actions; it never widens them.
  it('AC-17: CREATED with the permitted set {start, fix} offers only start', () => {
    expect(allowedActions(TicketStatus.CREATED, new Set<TicketAction>(['start', 'fix']))).toEqual(['start']);
  });

  // AC-18: close is offered from a close source only when its key is held.
  it('AC-18: IN_PROGRESS with the permitted set {close} offers only close', () => {
    expect(allowedActions(TicketStatus.IN_PROGRESS, new Set<TicketAction>(['close']))).toEqual(['close']);
  });

  it('a permitted action that is invalid from the status is dropped, so fix is never offered on CREATED', () => {
    expect(allowedActions(TicketStatus.CREATED, new Set<TicketAction>(['fix']))).toEqual([]);
    expect(allowedActions(TicketStatus.VERIFIED, new Set<TicketAction>(['fix']))).toEqual([]);
    expect(allowedActions(TicketStatus.IN_PROGRESS, new Set<TicketAction>(['fix']))).toEqual(['fix']);
  });
});
