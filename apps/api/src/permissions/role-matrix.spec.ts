import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { OWNABLE_KEYS, PERMISSION_CATALOG } from './catalog';
import { PermissionCache } from './permission-cache';
import { PermissionService } from './permission.service';
import type { PermissionDecision, PrincipalRef, RoleSeed } from './permissions.types';
import { SYSTEM_ROLES } from './system-roles';
import { FakeCacheManager, InMemoryPermissionStore } from './test-helpers/in-memory-permissions';

/**
 * US-005 — the seeded-role allow/deny matrix.
 *
 * One row per seeded role, one column per catalog key, and the cell is the pair of reasons
 * `PermissionService.can` answers: the global one and the one inside project `p1`. The matrix is
 * serialised and compared with `__snapshots__/role-matrix.json`, so a seeded role, the catalog or a
 * decision rule that drifts shows up as a reviewed diff of that file (`bunx vitest run -u`
 * regenerates it).
 *
 * The pinned cells below are the ones the design's Appendix A states, so the committed matrix is
 * also checked against the design itself and not only against the file.
 */

/** The project every project-scope cell is measured in. */
const PROJECT_ID = 'p1';

/** The committed matrix, next to this spec. */
const SNAPSHOT_FILE = './__snapshots__/role-matrix.json';

type Reason = PermissionDecision['reason'];
/** `[global reason, p1 reason]` for one (role, key) pair. */
type Cell = [Reason, Reason];
/** role key -> catalog key -> cell. */
type RoleMatrix = Record<string, Record<string, Cell>>;

const userPrincipal = (id: string): KodaPrincipal =>
  ({ actorType: 'user', id, role: 'MEMBER', email: `${id}@x.test` }) as KodaPrincipal;
const agentPrincipal = (id: string): KodaPrincipal =>
  ({ actorType: 'agent', id }) as unknown as KodaPrincipal;

/** One matrix row: the seeded role, the principal that holds it and the service that decides. */
interface Row {
  roleKey: string;
  principal: KodaPrincipal;
  /** The principal as a `PrincipalRef` — the `resource.createdBy` of a row it owns. */
  ref: PrincipalRef;
  service: PermissionService;
  cells: Record<string, Cell>;
}

/**
 * Builds the row of one seeded role over a fresh store and service, so no cached key carries from
 * one row into the next.
 *
 * The `agent` row is an AGENT principal holding the global `agent` role. Every other row is a USER
 * principal holding the global `member` baseline plus its own role — globally for a GLOBAL role
 * (`owner`, `admin`), in `p1` for a PROJECT role. The baseline is bound explicitly so the matrix
 * does not lean on `PermissionService`'s no-binding fallback, which drop-legacy removes.
 */
function buildRow(seed: RoleSeed): Row {
  const store = new InMemoryPermissionStore();
  const cache = new FakeCacheManager();
  const permissionCache = new PermissionCache(cache as never);
  const service = new PermissionService(
    store.roleRepo() as never,
    store.bindingRepo() as never,
    permissionCache,
  );
  store.projects.add(PROJECT_ID);

  const isAgent = seed.key === 'agent';
  const id = isAgent ? 'agent-1' : `user-${seed.key}`;
  const ref: PrincipalRef = { type: isAgent ? 'AGENT' : 'USER', id };

  if (isAgent) {
    store.agents.add(id);
    store.bind(ref, 'agent', null);
  } else {
    store.addUser(id);
    store.bind(ref, 'member', null);
    // The `member` row is the baseline binding itself.
    if (seed.key !== 'member') {
      store.bind(ref, seed.key, seed.scope === 'GLOBAL' ? null : PROJECT_ID);
    }
  }

  return {
    roleKey: seed.key,
    principal: isAgent ? agentPrincipal(id) : userPrincipal(id),
    ref,
    service,
    cells: {},
  };
}

/** Fills the row's cells: one per catalog key, in catalog order. */
async function computeCells(row: Row): Promise<void> {
  for (const entry of PERMISSION_CATALOG) {
    const global = await row.service.can(row.principal, entry.key, {});
    const inProject = await row.service.can(row.principal, entry.key, { projectId: PROJECT_ID });
    row.cells[entry.key] = [global.reason, inProject.reason];
  }
}

/**
 * Serialises the matrix with one line per cell, so a drifting cell is a one-line diff in the
 * committed file rather than a re-indented block.
 */
function serialiseMatrix(matrix: RoleMatrix): string {
  const roles = Object.keys(matrix).map((role) => {
    const cells = matrix[role];
    const lines = Object.keys(cells).map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(cells[key])},`);
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
    return [`  ${JSON.stringify(role)}: {`, ...lines, '  }'].join('\n');
  });
  return `{\n${roles.join(',\n')}\n}\n`;
}

/** The committed matrix, read back from the file the snapshot compares with. */
function readCommittedMatrix(): RoleMatrix {
  const path = join(__dirname, '__snapshots__', 'role-matrix.json');
  if (!existsSync(path)) throw new Error(`the committed role matrix is missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as RoleMatrix;
}

/**
 * The design's Appendix A cells, in the order the design table lists them. `scope` says which half
 * of the cell is meant: the global reason or the `p1` reason.
 */
const PINNED_CELLS: readonly { role: string; key: string; scope: 'global' | 'project'; reason: Reason }[] = [
  { role: 'viewer', key: 'ticket.create', scope: 'project', reason: 'not-granted' },
  { role: 'viewer', key: 'comment.create', scope: 'project', reason: 'granted' },
  { role: 'developer', key: 'ticket.transition.start', scope: 'project', reason: 'granted' },
  { role: 'developer', key: 'ticket.delete', scope: 'project', reason: 'not-granted' },
  { role: 'developer', key: 'comment.update', scope: 'project', reason: 'not-owner' },
  { role: 'project-admin', key: 'member.add', scope: 'project', reason: 'granted' },
  { role: 'project-admin', key: 'role.binding.manage', scope: 'project', reason: 'granted' },
  { role: 'project-admin', key: 'agent.update', scope: 'global', reason: 'not-granted' },
  { role: 'admin', key: 'role.binding.owner', scope: 'global', reason: 'not-granted' },
  { role: 'owner', key: 'role.binding.owner', scope: 'global', reason: 'granted' },
  { role: 'agent', key: 'role.binding.owner', scope: 'global', reason: 'principal-type' },
  { role: 'agent', key: 'mcp.access', scope: 'global', reason: 'implicit' },
  { role: 'member', key: 'thread.workspace.create', scope: 'global', reason: 'granted' },
  { role: 'member', key: 'project.create', scope: 'global', reason: 'not-granted' },
  { role: 'reviewer', key: 'ticket.transition.close', scope: 'project', reason: 'granted' },
  { role: 'triager', key: 'ticket.transition.reject', scope: 'project', reason: 'granted' },
  { role: 'approver', key: 'approval.decide', scope: 'project', reason: 'granted' },
];

/** The reasons the design table states, in the same order. */
const PINNED_REASONS: readonly Reason[] = [
  'not-granted',
  'granted',
  'granted',
  'not-granted',
  'not-owner',
  'granted',
  'granted',
  'not-granted',
  'not-granted',
  'granted',
  'principal-type',
  'implicit',
  'granted',
  'not-granted',
  'granted',
  'granted',
  'granted',
];

/** The project-scope role keys: the columns a project binding can decide. */
const PROJECT_SCOPE_ROLE_KEYS: readonly string[] = PERMISSION_CATALOG.filter(
  (entry) => entry.access === 'role' && entry.scope === 'project',
).map((entry) => entry.key);

/** The ownable keys: the columns that can answer `not-owner`. */
const OWNABLE_CATALOG_KEYS: readonly string[] = PERMISSION_CATALOG.filter((entry) =>
  OWNABLE_KEYS.has(entry.key),
).map((entry) => entry.key);

/** Reads the pinned half of a cell: the global reason or the `p1` reason. */
function readPinned(matrix: RoleMatrix): Reason[] {
  return PINNED_CELLS.map(({ role, key, scope }) => matrix[role][key][scope === 'global' ? 0 : 1]);
}

describe('the seeded-role allow/deny matrix', () => {
  let rows: Row[];
  let matrix: RoleMatrix;
  let serialised: string;

  beforeAll(async () => {
    rows = [];
    matrix = {};
    for (const seed of SYSTEM_ROLES) {
      const row = buildRow(seed);
      await computeCells(row);
      rows.push(row);
      matrix[seed.key] = row.cells;
    }
    serialised = serialiseMatrix(matrix);
  });

  /** Every (row, key) whose `p1` cell is `not-owner` — the cells an ownership check answers. */
  function notOwnerCells(): { row: Row; key: string }[] {
    return rows.flatMap((row) =>
      PERMISSION_CATALOG.filter((entry) => row.cells[entry.key][1] === 'not-owner').map((entry) => ({
        row,
        key: entry.key,
      })),
    );
  }

  it('AC-1: the serialised matrix equals the committed snapshot file', async () => {
    expect(JSON.parse(serialised)).toEqual(matrix);
    await expect(serialised).toMatchFileSnapshot(SNAPSHOT_FILE);
  });

  it('AC-2: the rows are the seeded roles in order and the columns are the catalog keys in order', () => {
    expect(Object.keys(matrix)).toEqual(SYSTEM_ROLES.map((seed) => seed.key));
    expect(Object.keys(matrix)).toHaveLength(11);

    for (const row of rows) {
      expect(Object.keys(row.cells)).toEqual(PERMISSION_CATALOG.map((entry) => entry.key));
      expect(Object.keys(row.cells)).toHaveLength(219);
    }
  });

  it('AC-8/9: Developer can decide shell escalation only in a project', () => {
    expect(matrix.developer['approval.decide'][0]).toBe('not-granted');
    expect(matrix.developer['approval.decide'][1]).toBe('granted');
  });

  it('US-001 AC-8/9/10/11: fleet ask permissions follow the seeded role patterns', () => {
    expect(matrix.developer['fleet.job.shell.escalate'][1]).toBe('granted');
    expect(matrix.developer['fleet.budget.override'][1]).toBe('not-granted');
    expect(matrix['project-admin']['fleet.budget.override'][1]).toBe('granted');
    expect(matrix.viewer['fleet.job.shell.escalate'][1]).toBe('not-granted');
  });

  it('AC-3: the 17 pinned cells of the design table hold in the matrix and in the committed file', () => {
    expect(PINNED_CELLS.map((cell) => cell.reason)).toEqual([...PINNED_REASONS]);
    expect(readPinned(matrix)).toEqual([...PINNED_REASONS]);
    expect(readPinned(readCommittedMatrix())).toEqual([...PINNED_REASONS]);
  });

  it('AC-13: approval.decide is a decision in every row, granted globally to owner and admin only', () => {
    // The key became `any`-scoped (US-001): its global cell is a decision now, not `no-project`.
    const globalDecide: Record<string, Reason> = {
      owner: 'granted',
      admin: 'granted',
      member: 'not-granted',
      agent: 'not-granted',
      'project-admin': 'not-granted',
      developer: 'not-granted',
      reviewer: 'not-granted',
      verifier: 'not-granted',
      triager: 'not-granted',
      approver: 'not-granted',
      viewer: 'not-granted',
    };
    // The project half of the cell is untouched by the scope change.
    const projectDecide: Record<string, Reason> = {
      owner: 'granted',
      admin: 'granted',
      member: 'not-granted',
      agent: 'not-granted',
      'project-admin': 'granted',
      developer: 'granted',
      reviewer: 'granted',
      verifier: 'not-granted',
      triager: 'not-granted',
      approver: 'granted',
      viewer: 'not-granted',
    };

    expect(Object.keys(globalDecide).sort()).toEqual(SYSTEM_ROLES.map((seed) => seed.key).sort());

    for (const seed of SYSTEM_ROLES) {
      expect([seed.key, matrix[seed.key]['approval.decide']]).toEqual([
        seed.key,
        [globalDecide[seed.key], projectDecide[seed.key]],
      ]);
    }
  });

  it('AC-4: the runner and system keys are non-role-key in every row', () => {
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.cells['runner.sync']).toEqual(['non-role-key', 'non-role-key']);
      expect(row.cells['system.outbox.dispatch']).toEqual(['non-role-key', 'non-role-key']);
    }
  });

  it('AC-5: the health key is public in every row', () => {
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.cells['health.read']).toEqual(['public', 'public']);
    }
  });

  it('AC-6: every project-scope role key is no-project globally', () => {
    expect(PROJECT_SCOPE_ROLE_KEYS.length).toBeGreaterThan(0);

    for (const row of rows) {
      for (const key of PROJECT_SCOPE_ROLE_KEYS) {
        expect(row.cells[key][0]).toBe('no-project');
      }
    }
  });

  it('AC-7: no project-scope role key is no-project inside p1', () => {
    expect(PROJECT_SCOPE_ROLE_KEYS.length).toBeGreaterThan(0);

    for (const row of rows) {
      for (const key of PROJECT_SCOPE_ROLE_KEYS) {
        expect(row.cells[key][1]).not.toBe('no-project');
      }
    }
  });

  it('AC-8: the creator of a row is granted every ownable key the row holds', async () => {
    const owned = notOwnerCells();
    expect(owned.length).toBeGreaterThan(0);

    for (const { row, key } of owned) {
      const decision = await row.service.can(row.principal, key, {
        projectId: PROJECT_ID,
        resource: { createdBy: row.ref },
      });
      expect(decision).toEqual({ allowed: true, reason: 'granted' });
    }
  });

  it('AC-9: a row owned by somebody else stays not-owner', async () => {
    const owned = notOwnerCells();
    expect(owned.length).toBeGreaterThan(0);

    for (const { row, key } of owned) {
      const decision = await row.service.can(row.principal, key, {
        projectId: PROJECT_ID,
        resource: { createdBy: { type: 'USER', id: 'someone-else' } },
      });
      expect(decision).toEqual({ allowed: false, reason: 'not-owner' });
    }
  });

  it('AC-10: an ownable key the row holds outright ignores the owner of the row', async () => {
    const granted = rows.flatMap((row) =>
      OWNABLE_CATALOG_KEYS.filter((key) => row.cells[key][1] === 'granted').map((key) => ({ row, key })),
    );
    expect(granted.length).toBeGreaterThan(0);

    for (const { row, key } of granted) {
      const decision = await row.service.can(row.principal, key, {
        projectId: PROJECT_ID,
        resource: { createdBy: { type: 'USER', id: 'someone-else' } },
      });
      expect(decision).toEqual({ allowed: true, reason: 'granted' });
    }
  });
});
