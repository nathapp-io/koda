import { readFileSync } from 'fs';
import { join } from 'path';
import {
  findCatalogEntry,
  IMPLICIT_KEYS,
  OWNABLE_KEYS,
  PERMISSION_CATALOG,
  PUBLIC_KEYS,
  type PermissionCatalogEntry,
} from './catalog';
import { expandEntries } from './entry-matcher';

/**
 * The catalog is derived from `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`.
 * This spec re-reads that file and re-derives every entry from the rules in the design
 * (`docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` §1, Appendix A), so a
 * rule that only lives in prose — or a hand-copied key/scope that drifts from the TSV — fails here.
 */
type RawScope = 'global' | 'project' | 'runner' | 'system' | 'public' | 'implicit' | 'own';
type CatalogScope = 'global' | 'project' | 'any';
type CatalogAccess = 'role' | 'implicit' | 'public' | 'runner' | 'system';
type CatalogRisk = 'low' | 'medium' | 'high' | 'critical';

const INVENTORY_PATH = join(
  __dirname,
  '../../../../docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv',
);
const OWN_ROW = 'own (see design §1)';

const PUBLIC_KEY_LIST = [
  'session.login',
  'session.refresh',
  'auth.register',
  'auth.registration.read',
  'health.read',
  'invite.preview',
  'invite.accept',
  'ci.webhook.ingest',
  'vcs.webhook.ingest',
];

const IMPLICIT_KEY_LIST = [
  'auth.me.read',
  'session.logout',
  'approval.request.cancel',
  'home.read',
  'notification.read',
  'notification.mark-read',
  'notification.preference.read',
  'notification.preference.update',
  'agent.self.read',
  'assistant.action.read',
  'mcp.access',
];

const OWNABLE_KEY_LIST = [
  'comment.update',
  'comment.delete',
  'ticket.link.remove',
  'memory.update',
  'kb.document.delete',
  'thread.cap.update',
  'thread.plan',
  'thread.run',
  'thread.stop',
  'thread.end-session',
  'thread.answer',
  'thread.archive',
  'thread.publish',
  'thread.discard',
  'thread.message.send',
  'thread.workspace.read',
  'thread.workspace.message.send',
  'thread.workspace.archive',
  'fleet.schedule.update',
  'fleet.schedule.delete',
];

/** Keys the design adds on top of the TSV (Appendix A), with the scope it gives them. */
const NEW_KEY_SCOPES: Readonly<Record<string, CatalogScope>> = {
  'role.read': 'global',
  'role.manage': 'global',
  'role.binding.global': 'global',
  'role.binding.owner': 'global',
  'approval.decide': 'any',
  'approval.request.cancel': 'any',
  'approval.policy.read': 'project',
  'approval.policy.manage': 'any',
  'audit.read': 'global',
  'memory.update': 'any',
};
const NEW_KEY_LIST = Object.keys(NEW_KEY_SCOPES);

/** Prefixes the design marks as high-risk writes. */
const HIGH_RISK_PREFIXES = [
  'vcs.connection.',
  'vcs.webhook-secret.',
  'webhook.',
  'fleet.repo.',
  'fleet.runner.',
  'fleet.budget.',
  'fleet.enrollment.',
  'fleet.credential.',
];

/** `[key, catalog_scope]` in file order, with cells holding several keys split on `;`. */
function readInventory(): { keys: string[]; scope: RawScope }[] {
  const lines = readFileSync(INVENTORY_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const header = lines[0].split('\t');
  const keyIndex = header.indexOf('proposed_key');
  const scopeIndex = header.indexOf('catalog_scope');

  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const raw = cells[scopeIndex];
    return {
      keys: cells[keyIndex]
        .split(';')
        .map((key) => key.trim())
        .filter(Boolean),
      scope: (raw === OWN_ROW ? 'own' : raw) as RawScope,
    };
  });
}

const INVENTORY = readInventory();
const INVENTORY_KEYS = [...new Set(INVENTORY.flatMap((row) => row.keys))];

const SCOPES_BY_KEY = new Map<string, Set<RawScope>>();
for (const row of INVENTORY) {
  for (const key of row.keys) {
    const scopes = SCOPES_BY_KEY.get(key) ?? new Set<RawScope>();
    scopes.add(row.scope);
    SCOPES_BY_KEY.set(key, scopes);
  }
}

function expectedAccess(key: string): CatalogAccess {
  if (key.startsWith('runner.')) return 'runner';
  if (key.startsWith('system.')) return 'system';
  if (PUBLIC_KEY_LIST.includes(key)) return 'public';
  if (IMPLICIT_KEY_LIST.includes(key)) return 'implicit';
  return 'role';
}

function expectedScope(key: string, access: CatalogAccess, ownable: boolean): CatalogScope {
  if (access !== 'role' || ownable) return 'any';
  if (NEW_KEY_SCOPES[key] !== undefined) return NEW_KEY_SCOPES[key];

  const scopes = SCOPES_BY_KEY.get(key) ?? new Set<RawScope>();
  const global = scopes.has('global') || scopes.has('runner');
  const project = scopes.has('project');
  if (scopes.has('own') || (global && project)) return 'any';
  if (project) return 'project';
  if (global) return 'global';
  return 'any';
}

function expectedRisk(key: string): CatalogRisk {
  if (key.startsWith('role.') || key.startsWith('approval.policy.')) return 'critical';
  const last = key.slice(key.lastIndexOf('.') + 1);
  if (last === 'read') return 'low';
  if (last === 'delete' || last === 'remove') return 'high';
  if (HIGH_RISK_PREFIXES.some((prefix) => key.startsWith(prefix))) return 'high';
  return 'medium';
}

describe('PERMISSION_CATALOG', () => {
  it('US-001 AC-1/2: code-intel read and index keys are project role keys', () => {
    expect(findCatalogEntry('codeintel.read')).toMatchObject({ scope: 'project', access: 'role' });
    expect(findCatalogEntry('codeintel.index.write')).toMatchObject({ scope: 'project', access: 'role' });
  });

  it('US-001 AC-3/4: intake keys are public', () => {
    for (const key of ['ci.webhook.ingest', 'vcs.webhook.ingest']) {
      expect(findCatalogEntry(key)?.access).toBe('public');
      expect(PUBLIC_KEYS.has(key)).toBe(true);
    }
  });

  it('US-001 AC-5/6/7: seeded project role patterns expand to the intended code-intel and intake keys', async () => {
    const { SYSTEM_ROLES } = await import('./system-roles');
    const roleKeys = (name: string) => {
      const role = SYSTEM_ROLES.find((entry) => entry.key === name);
      if (!role) throw new Error(`Missing seeded role: ${name}`);
      return expandEntries(role.permissions, 'PROJECT');
    };
    const developer = roleKeys('developer');
    expect(developer.has('codeintel.read')).toBe(true);
    expect(developer.has('codeintel.index.write')).toBe(true);
    const viewer = roleKeys('viewer');
    expect(viewer.has('codeintel.read')).toBe(true);
    expect(viewer.has('codeintel.index.write')).toBe(false);
    const admin = roleKeys('project-admin');
    expect(admin.has('ci.webhook.ingest')).toBe(false);
    expect(admin.has('vcs.webhook.ingest')).toBe(false);
  });
  it('AC-1: every proposed_key in the action inventory resolves to an entry with that key', () => {
    expect(INVENTORY_KEYS.length).toBeGreaterThan(200);

    const missing = INVENTORY_KEYS.filter((key) => findCatalogEntry(key)?.key !== key);

    expect(missing).toEqual([]);
  });

  it('AC-2: resolves every key the design adds on top of the inventory', () => {
    const missing = NEW_KEY_LIST.filter((key) => findCatalogEntry(key)?.key !== key);

    expect(missing).toEqual([]);
  });

  it('AC-3: returns undefined for a key that is in no catalog', () => {
    expect(findCatalogEntry('no.such.key')).toBeUndefined();
  });

  it('AC-4: runner.sync is runner access', () => {
    expect(findCatalogEntry('runner.sync')?.access).toBe('runner');
  });

  it('AC-5: system.schedule.dispatch is system access', () => {
    expect(findCatalogEntry('system.schedule.dispatch')?.access).toBe('system');
  });

  it('AC-6: notification.read is implicit access', () => {
    expect(findCatalogEntry('notification.read')?.access).toBe('implicit');
  });

  it('AC-7: mcp.access is implicit access', () => {
    expect(findCatalogEntry('mcp.access')?.access).toBe('implicit');
  });

  it('AC-8: session.login is public access', () => {
    expect(findCatalogEntry('session.login')?.access).toBe('public');
  });

  it('AC-9: ticket.delete is a role key scoped to a project', () => {
    expect(findCatalogEntry('ticket.delete')?.access).toBe('role');
    expect(findCatalogEntry('ticket.delete')?.scope).toBe('project');
  });

  it('AC-10: user.create is scoped globally', () => {
    expect(findCatalogEntry('user.create')?.scope).toBe('global');
  });

  it('AC-11: fleet.runner.update is scoped globally', () => {
    // Its inventory rows are the admin runner routes (`catalog_scope` runner counts as global).
    expect(findCatalogEntry('fleet.runner.update')?.scope).toBe('global');
  });

  it('AC-12: agent.read is scoped any', () => {
    expect(findCatalogEntry('agent.read')?.scope).toBe('any');
  });

  it('US-001 AC-13: the four surviving agent-management keys are scoped globally', () => {
    // `agent.roles.update` is folded into `agent.update` (US-001 of the contract-tests feature).
    const agentManagementKeys = [
      'agent.update',
      'agent.delete',
      'agent.key.rotate',
      'agent.capabilities.update',
    ];

    for (const key of agentManagementKeys) {
      expect([key, findCatalogEntry(key)?.scope]).toEqual([key, 'global']);
    }
  });

  it('US-001 AC-14: agent.pickup stays scoped to a project', () => {
    expect(findCatalogEntry('agent.pickup')?.scope).toBe('project');
  });

  it('AC-13: comment.update is scoped any', () => {
    expect(findCatalogEntry('comment.update')?.scope).toBe('any');
  });

  it('AC-14: comment.update is ownable', () => {
    expect(findCatalogEntry('comment.update')?.ownable).toBe(true);
  });

  it('AC-15: thread.stop is ownable', () => {
    expect(findCatalogEntry('thread.stop')?.ownable).toBe(true);
  });

  it('AC-16: ticket.delete is not ownable', () => {
    expect(findCatalogEntry('ticket.delete')?.ownable).toBe(false);
  });

  it('AC-17: thread.create is not ownable', () => {
    expect(findCatalogEntry('thread.create')?.ownable).toBe(false);
  });

  it('US-001 AC-12: fleet.activity.read is scoped to a project', () => {
    // Re-scoped from global: every project role's `*.read` holds it, and a global admin still does
    // everywhere (it holds every project key in the global set).
    expect(findCatalogEntry('fleet.activity.read')?.scope).toBe('project');
  });

  it('US-001 AC-13: fleet.schedule.update is ownable', () => {
    expect(findCatalogEntry('fleet.schedule.update')?.ownable).toBe(true);
  });

  it('US-001 AC-14: fleet.schedule.delete is ownable', () => {
    expect(findCatalogEntry('fleet.schedule.delete')?.ownable).toBe(true);
  });

  it('AC-18: ticket.delete is high risk', () => {
    expect(findCatalogEntry('ticket.delete')?.risk).toBe('high');
  });

  it('AC-19: ticket.read is low risk', () => {
    expect(findCatalogEntry('ticket.read')?.risk).toBe('low');
  });

  it('AC-20: role.read is critical risk', () => {
    expect(findCatalogEntry('role.read')?.risk).toBe('critical');
  });

  it('AC-21: ticket.create is medium risk', () => {
    expect(findCatalogEntry('ticket.create')?.risk).toBe('medium');
  });

  it('AC-22: only a user can hold role.binding.owner', () => {
    expect(findCatalogEntry('role.binding.owner')?.principals).toEqual(['user']);
  });

  it('AC-23: ticket.create is open to users and agents', () => {
    expect(findCatalogEntry('ticket.create')?.principals).toEqual(['user', 'agent']);
  });

  it('holds exactly the inventory keys plus the keys the design adds, with no duplicates', () => {
    const keys = PERMISSION_CATALOG.map((entry) => entry.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...INVENTORY_KEYS, ...NEW_KEY_LIST].sort());
  });

  it('exports the public, implicit and ownable key sets the entry grammar depends on', () => {
    expect([...PUBLIC_KEYS].sort()).toEqual([...PUBLIC_KEY_LIST].sort());
    expect([...IMPLICIT_KEYS].sort()).toEqual([...IMPLICIT_KEY_LIST].sort());
    expect([...OWNABLE_KEYS].sort()).toEqual([...OWNABLE_KEY_LIST].sort());
    for (const key of OWNABLE_KEY_LIST) {
      expect(findCatalogEntry(key)?.ownable).toBe(true);
    }
  });

  it('derives access, scope, ownable, risk, principals and approval for every catalog key', () => {
    const isReadKey = (key: string) => key.slice(key.lastIndexOf('.') + 1) === 'read';
    const derive = (key: string): Partial<PermissionCatalogEntry> => {
      const access = expectedAccess(key);
      const ownable = access === 'role' && OWNABLE_KEY_LIST.includes(key);
      const risk = expectedRisk(key);
      // Reads are never approvable (design §4); nothing unapprovable carries a floor or default.
      const approvable = access === 'role' && risk !== 'low' && !isReadKey(key);
      return {
        access,
        scope: expectedScope(key, access, ownable),
        ownable,
        risk,
        principals: key === 'role.binding.owner' ? ['user'] : ['user', 'agent'],
        approval: {
          approvable,
          floor: approvable && risk === 'critical' ? 'human' : 'none',
          default: !approvable ? 'none' : risk === 'critical' ? 'human' : risk === 'high' ? 'agent' : 'none',
        },
      };
    };

    const mismatches = [...INVENTORY_KEYS, ...NEW_KEY_LIST].flatMap((key) => {
      const actual = findCatalogEntry(key);
      const expected = derive(key);
      return (Object.keys(expected) as (keyof PermissionCatalogEntry)[]).flatMap((field) =>
        JSON.stringify(actual?.[field]) === JSON.stringify(expected[field])
          ? []
          : [
              `${key}.${field}: expected ${JSON.stringify(expected[field])}, got ${JSON.stringify(
                actual?.[field],
              )}`,
            ],
      );
    });

    expect(mismatches).toEqual([]);
    expect(PERMISSION_CATALOG).toHaveLength(INVENTORY_KEYS.length + NEW_KEY_LIST.length);
  });
});

/**
 * Permissions P3 approval core (US-001): the risk-derived approval metadata every catalog entry
 * carries — whether the action can be approvable at all, the floor a policy may not go below, and
 * the mode an `AGENT` subject gets when no policy matches (design §4).
 */
describe('catalog approval metadata', () => {
  const approvalOf = (key: string) => {
    const entry = findCatalogEntry(key);
    if (entry === undefined) throw new Error(`missing catalog entry: ${key}`);
    return entry.approval;
  };

  it('AC-1: ticket.delete is approvable, unfloored and agent-approved by default (risk high)', () => {
    expect(approvalOf('ticket.delete')).toEqual({ approvable: true, floor: 'none', default: 'agent' });
  });

  it('AC-2: role.manage is approvable with a human floor and a human default (risk critical)', () => {
    expect(approvalOf('role.manage')).toEqual({ approvable: true, floor: 'human', default: 'human' });
  });

  it('AC-3: approval.policy.manage is approvable with a human floor and a human default (risk critical)', () => {
    expect(approvalOf('approval.policy.manage')).toEqual({
      approvable: true,
      floor: 'human',
      default: 'human',
    });
  });

  it('AC-4: role.read is critical but a read, so it is neither approvable nor floored', () => {
    expect(approvalOf('role.read')).toEqual({ approvable: false, floor: 'none', default: 'none' });
  });

  it('AC-5: ticket.create is approvable with no floor and no default (risk medium)', () => {
    expect(approvalOf('ticket.create')).toEqual({ approvable: true, floor: 'none', default: 'none' });
  });

  it('AC-6: ticket.read is not approvable (risk low)', () => {
    expect(approvalOf('ticket.read').approvable).toBe(false);
  });

  it('AC-7: session.login is not approvable (access public)', () => {
    expect(approvalOf('session.login').approvable).toBe(false);
  });

  it('AC-8: nothing unapprovable carries a floor or a default', () => {
    const unapprovable = PERMISSION_CATALOG.filter((entry) => !entry.approval.approvable);
    expect(unapprovable.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([
        'role.read',
        'approval.policy.read',
        'ticket.read',
        'session.login',
        'runner.sync',
        'system.outbox.dispatch',
      ]),
    );

    const drift = unapprovable
      .filter((entry) => entry.approval.floor !== 'none' || entry.approval.default !== 'none')
      .map((entry) => `${entry.key}: floor=${entry.approval.floor} default=${entry.approval.default}`);

    expect(drift).toEqual([]);
  });

  it('AC-9: only role and policy keys are floored at human', () => {
    const floored = PERMISSION_CATALOG.filter((entry) => entry.approval.floor === 'human');
    expect(floored.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['role.manage', 'role.binding.global', 'approval.policy.manage']),
    );

    const elsewhere = floored
      .filter((entry) => !entry.key.startsWith('role.') && !entry.key.startsWith('approval.policy.'))
      .map((entry) => entry.key);

    expect(elsewhere).toEqual([]);
  });

  it('AC-10: approval.decide is scoped any, so a global role can hold it', () => {
    expect(findCatalogEntry('approval.decide')?.scope).toBe('any');
  });

  it('AC-11: the `*` entry of a GLOBAL role includes approval.decide', () => {
    expect(expandEntries(['*'], 'GLOBAL').has('approval.decide')).toBe(true);
  });

  it('AC-12: a PROJECT role can still name approval.decide', () => {
    expect(expandEntries(['approval.decide'], 'PROJECT').has('approval.decide')).toBe(true);
  });
});

it('cancel AC-1: cancellation is implicit, any-scope and not approvable', () => {
  expect(findCatalogEntry('approval.request.cancel')).toMatchObject({ access: 'implicit', scope: 'any', approval: { approvable: false } });
});
