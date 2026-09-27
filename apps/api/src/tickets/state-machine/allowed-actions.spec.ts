import { allowedActions, canOverrideClose, TICKET_ACTIONS } from './allowed-actions';
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
  const roles = [
    ['project ADMIN', { canTransition: true, canClose: true }],
    ['DEVELOPER', { canTransition: true, canClose: false }],
    ['VIEWER', { canTransition: false, canClose: false }],
  ] as const;

  describe.each(roles)('%s', (_role, perms) => {
    it.each(ALL_STATUSES)('from %s: every action offered passes validateTransition', (status) => {
      for (const action of allowedActions(status, perms)) {
        if (action === 'close') {
          expect(CLOSE_SOURCES).toContain(status);
          continue;
        }
        expect(ENDPOINT_TARGETS[action].some(([to, c]) => passes(status, to, c))).toBe(true);
      }
    });

    it.each(ALL_STATUSES)('from %s: offers exactly the permitted actions', (status) => {
      const actions = allowedActions(status, perms);
      if (!perms.canTransition) expect(actions.filter((a) => a !== 'close')).toEqual([]);
      expect(actions.includes('close')).toBe(perms.canClose && CLOSE_SOURCES.includes(status));
    });
  });

  it('covers every reachable rule in TRANSITION_RULES for a transition-capable caller', () => {
    const perms = { canTransition: true, canClose: false };
    for (const [from, targets] of Object.entries(TRANSITION_RULES) as Array<[TicketStatus, Record<string, unknown>]>) {
      for (const to of Object.keys(targets) as TicketStatus[]) {
        // IN_PROGRESS -> VERIFIED needs a GENERAL comment no route supplies: unreachable by design.
        if (from === TicketStatus.IN_PROGRESS && to === TicketStatus.VERIFIED) continue;
        const actions = allowedActions(from, perms).filter((a): a is keyof typeof ENDPOINT_TARGETS => a !== 'close');
        expect({ from, to, covered: actions.some((a) => ENDPOINT_TARGETS[a].some(([t]) => t === to)) })
          .toEqual({ from, to, covered: true });
      }
    }
  });

  it('terminal statuses offer nothing, even to an admin', () => {
    const perms = { canTransition: true, canClose: true };
    expect(allowedActions(TicketStatus.CLOSED, perms)).toEqual([]);
    expect(allowedActions(TicketStatus.REJECTED, perms)).toEqual([]);
  });

  it('never offers verify-fix outside VERIFY_FIX (regression: NONE rules ignore the comment type)', () => {
    const perms = { canTransition: true, canClose: true };
    for (const status of [TicketStatus.CREATED, TicketStatus.VERIFIED, TicketStatus.IN_PROGRESS]) {
      expect(allowedActions(status, perms)).not.toContain('verify-fix');
    }
  });

  it('keeps a stable order for rendering', () => {
    expect(allowedActions(TicketStatus.CREATED, { canTransition: true, canClose: true })).toEqual(['verify', 'start', 'reject']);
    expect(allowedActions(TicketStatus.VERIFY_FIX, { canTransition: true, canClose: true })).toEqual(['verify-fix', 'close']);
  });
});
