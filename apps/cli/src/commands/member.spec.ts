jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectMembersControllerList: jest.fn(),
  projectMembersControllerAdd: jest.fn(),
  roleBindingsControllerRemove: jest.fn(),
  projectInvitesControllerCreate: jest.fn(),
  projectInvitesControllerList: jest.fn(),
  projectInvitesControllerResend: jest.fn(),
  projectInvitesControllerCancel: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));
// Wrap (do not replace) the real handler: AC-14 asserts the exact error object it receives, while every
// other test still gets the real exit codes and stderr text.
jest.mock('../utils/error', () => {
  const actual = jest.requireActual<typeof import('../utils/error')>('../utils/error');
  return { ...actual, handleApiError: jest.fn(actual.handleApiError) };
});

import { Command } from 'commander';
import { memberCommand } from './member';
import {
  projectMembersControllerAdd,
  projectMembersControllerList,
  projectInvitesControllerCreate,
  projectInvitesControllerList,
  projectInvitesControllerResend,
  projectInvitesControllerCancel,
  roleBindingsControllerRemove,
} from '../generated';
import { resolveContext } from '../config';
import { handleApiError } from '../utils/error';

const CTX = { apiKey: 'k', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

function logLines(): string[] {
  return (console.log as jest.Mock).mock.calls.map((call) => String(call[0]));
}

function loggedText(): string {
  return logLines().join('\n');
}

/** Table cells of a rendered row: `table()` separates columns with two spaces. */
function cellsOf(line: string): string[] {
  return line.split(/\s{2,}/).map((cell) => cell.trim());
}

interface TestBinding {
  id: string;
  roleKey: string;
  roleName: string;
}

interface TestMember {
  principalType: 'USER' | 'AGENT';
  principalId: string;
  email?: string | null;
  agentSlug?: string | null;
  name?: string | null;
  bindings: TestBinding[];
}

function memberPage(records: TestMember[], overrides: Record<string, unknown> = {}): { ret: number; data: unknown } {
  return {
    ret: 0,
    data: { total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, records, ...overrides },
  };
}

describe('memberCommand', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    memberCommand(program);
    // withContext passes the flags straight to resolveContext; honor --project.
    (resolveContext as jest.Mock).mockImplementation(async (flags: { projectSlug?: string }) => ({
      ...CTX,
      projectSlug: flags.projectSlug ?? CTX.projectSlug,
    }));
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  // ---------------------------------------------------------------------------
  // US-009 — member list on principals and bindings
  // ---------------------------------------------------------------------------

  it('AC-5: member list --all asks for every principal', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue(memberPage([]));
    await program.parseAsync(['node', 'koda', 'member', 'list', '--all']).catch(() => undefined);
    expect(projectMembersControllerList).toHaveBeenCalledWith({
      path: { slug: 'my-proj' },
      query: { current: 1, size: 20, principals: 'all' },
    });
  });

  it('AC-6: member list prints the principal/roles header', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue(memberPage([]));
    await program.parseAsync(['node', 'koda', 'member', 'list']).catch(() => undefined);
    expect(logLines().map(cellsOf)).toContainEqual(['Type', 'ID', 'Email/Slug', 'Name', 'Roles']);
  });

  it('AC-7: member list shows an agent row keyed by its agent slug', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue(
      memberPage([
        {
          principalType: 'AGENT',
          principalId: 'a1',
          email: null,
          agentSlug: 'bot-1',
          name: 'Bot One',
          bindings: [{ id: 'b9', roleKey: 'viewer', roleName: 'Viewer' }],
        },
      ]),
    );
    await program.parseAsync(['node', 'koda', 'member', 'list', '--all']).catch(() => undefined);
    const row = logLines().find((line) => line.includes('AGENT'));
    expect(row).toBeDefined();
    expect(cellsOf(row as string)).toEqual(['AGENT', 'a1', 'bot-1', 'Bot One', 'viewer (b9)']);
  });

  it('AC-8: member list renders every binding as roleKey (bindingId)', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue(
      memberPage([
        {
          principalType: 'USER',
          principalId: 'u1',
          email: 'dev@x.io',
          name: 'Dev',
          bindings: [
            { id: 'b1', roleKey: 'developer', roleName: 'Developer' },
            { id: 'b2', roleKey: 'viewer', roleName: 'Viewer' },
          ],
        },
      ]),
    );
    await program.parseAsync(['node', 'koda', 'member', 'list']).catch(() => undefined);
    const row = logLines().find((line) => line.includes('dev@x.io'));
    expect(row).toBeDefined();
    expect(cellsOf(row as string)).toEqual(['USER', 'u1', 'dev@x.io', 'Dev', 'developer (b1), viewer (b2)']);
  });

  it('list pages members of the context project', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: { total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] } });
    await program.parseAsync(['node', 'koda', 'member', 'list', '--page', '2']);
    expect(projectMembersControllerList).toHaveBeenCalledWith({ path: { slug: 'my-proj' }, query: { current: 2, size: 20 } });
  });

  it('AC-1: member add sends the role key verbatim', async () => {
    (projectMembersControllerAdd as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { principalType: 'USER', principalId: 'u1', email: 'dev@x.io', name: 'Dev', bindings: [] },
    });
    await program.parseAsync(['node', 'koda', 'member', 'add', '--email', 'dev@x.io', '--role', 'developer']);
    expect(projectMembersControllerAdd).toHaveBeenCalledWith({
      path: { slug: 'my-proj' },
      body: { email: 'dev@x.io', roleKey: 'developer' },
    });
  });

  it('AC-2: member add prints the granted role name', async () => {
    (projectMembersControllerAdd as jest.Mock).mockResolvedValue({
      ret: 0,
      data: {
        principalType: 'USER',
        principalId: 'u1',
        email: 'dev@x.io',
        name: 'Dev',
        bindings: [{ id: 'b1', roleKey: 'developer', roleName: 'Developer' }],
      },
    });
    await program.parseAsync(['node', 'koda', 'member', 'add', '--email', 'dev@x.io', '--role', 'developer']);
    expect(loggedText()).toContain('Added dev@x.io as Developer');
  });

  it('AC-3: member invite sends the role key verbatim', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { outcome: 'INVITED', emailed: true, invitePath: '/invite/abc' },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'new@x.io', '--role', 'triager'])
      .catch(() => undefined);
    expect(projectInvitesControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'my-proj' },
      body: { email: 'new@x.io', roleKey: 'triager' },
    });
  });

  it('AC-4: member invite prints the added member\'s role names', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: {
        outcome: 'ADDED',
        member: {
          principalType: 'USER',
          principalId: 'u1',
          email: 'existing@x.io',
          name: 'Existing',
          bindings: [{ id: 'b1', roleKey: 'viewer', roleName: 'Viewer' }],
        },
      },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'existing@x.io', '--role', 'viewer'])
      .catch(() => undefined);
    expect(loggedText()).toContain('Added existing@x.io as Viewer');
  });

  it('AC-10: member remove pages the member list and revokes each binding in order', async () => {
    (projectMembersControllerList as jest.Mock)
      .mockResolvedValueOnce(
        memberPage([{ principalType: 'USER', principalId: 'u1', email: 'one@x.io', bindings: [] }], { current: 1, hasNext: true }),
      )
      .mockResolvedValueOnce(
        memberPage(
          [
            {
              principalType: 'USER',
              principalId: 'u2',
              email: 'two@x.io',
              bindings: [
                { id: 'b1', roleKey: 'developer', roleName: 'Developer' },
                { id: 'b2', roleKey: 'viewer', roleName: 'Viewer' },
              ],
            },
          ],
          { current: 2, hasNext: false },
        ),
      );
    (roleBindingsControllerRemove as jest.Mock).mockResolvedValue({ ret: 0, data: null });

    await program.parseAsync(['node', 'koda', 'member', 'remove', 'u2']).catch(() => undefined);

    expect(projectMembersControllerList).toHaveBeenNthCalledWith(1, {
      path: { slug: 'my-proj' },
      query: { current: 1, size: 100 },
    });
    expect(projectMembersControllerList).toHaveBeenNthCalledWith(2, {
      path: { slug: 'my-proj' },
      query: { current: 2, size: 100 },
    });
    const remove = roleBindingsControllerRemove as jest.Mock;
    expect(remove.mock.calls).toEqual([[{ path: { id: 'b1' } }], [{ path: { id: 'b2' } }]]);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[1]);
    expect(loggedText()).toContain('Removed u2');
  });

  it('AC-11: member remove of an unlisted user exits 1 without revoking anything', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue(
      memberPage([{ principalType: 'USER', principalId: 'u1', email: 'one@x.io', bindings: [] }], { hasNext: false }),
    );

    await program.parseAsync(['node', 'koda', 'member', 'remove', 'u9']).catch(() => undefined);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(roleBindingsControllerRemove).not.toHaveBeenCalled();
    expect(String((console.error as jest.Mock).mock.calls[0][0])).toContain('Not a member: u9');
  });

  it('AC-12: member remove stops at a refused binding delete', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue(
      memberPage([
        {
          principalType: 'USER',
          principalId: 'u2',
          email: 'two@x.io',
          bindings: [
            { id: 'b1', roleKey: 'project-admin', roleName: 'Project Admin' },
            { id: 'b2', roleKey: 'viewer', roleName: 'Viewer' },
          ],
        },
      ]),
    );
    (roleBindingsControllerRemove as jest.Mock).mockRejectedValue({ statusCode: 409, message: 'members.lastAdmin' });

    await program.parseAsync(['node', 'koda', 'member', 'remove', 'u2']).catch(() => undefined);

    expect(roleBindingsControllerRemove).toHaveBeenCalledTimes(1);
    expect(roleBindingsControllerRemove).toHaveBeenCalledWith({ path: { id: 'b1' } });
  });

  it('AC-14: member remove hands the refused delete unchanged to handleApiError', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue(
      memberPage([
        {
          principalType: 'USER',
          principalId: 'u2',
          email: 'two@x.io',
          bindings: [{ id: 'b1', roleKey: 'project-admin', roleName: 'Project Admin' }],
        },
      ]),
    );
    const refusal = { statusCode: 409, message: 'members.lastAdmin' };
    (roleBindingsControllerRemove as jest.Mock).mockRejectedValue(refusal);

    await program.parseAsync(['node', 'koda', 'member', 'remove', 'u2']).catch(() => undefined);

    expect(handleApiError).toHaveBeenCalledWith(refusal);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('member remove honors the --project override and revokes the bindings it found', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue(
      memberPage([
        {
          principalType: 'USER',
          principalId: 'u1',
          email: 'one@x.io',
          bindings: [{ id: 'b1', roleKey: 'developer', roleName: 'Developer' }],
        },
      ]),
    );
    (roleBindingsControllerRemove as jest.Mock).mockResolvedValue({ ret: 0, data: null });

    await program.parseAsync(['node', 'koda', 'member', 'remove', 'u1', '--project', 'other']).catch(() => undefined);

    expect(projectMembersControllerList).toHaveBeenCalledWith({ path: { slug: 'other' }, query: { current: 1, size: 100 } });
    expect(roleBindingsControllerRemove).toHaveBeenCalledWith({ path: { id: 'b1' } });
  });

  it('member remove never matches an agent with the user id it was given', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue(
      memberPage([
        {
          principalType: 'AGENT',
          principalId: 'u2',
          agentSlug: 'bot-2',
          bindings: [{ id: 'a1', roleKey: 'viewer', roleName: 'Viewer' }],
        },
      ]),
    );

    await program.parseAsync(['node', 'koda', 'member', 'remove', 'u2']).catch(() => undefined);

    expect(roleBindingsControllerRemove).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  // ---------------------------------------------------------------------------
  // US-009 — the enum-based role subcommand is gone
  // ---------------------------------------------------------------------------

  it('AC-13: memberCommand registers no role subcommand under member', async () => {
    const member = program.commands.find((command) => command.name() === 'member');
    expect(member).toBeDefined();
    expect(member?.commands.map((command) => command.name())).not.toContain('role');
  });

  // ---------------------------------------------------------------------------
  // US-006 — invite / invites commands
  // ---------------------------------------------------------------------------

  it('AC1: member invite sends the context project slug and the email/roleKey body', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { outcome: 'INVITED', emailed: true, invitePath: '/invite/abc' },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'viewer'])
      .catch(() => undefined);
    expect(projectInvitesControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'my-proj' },
      body: { email: 'n@x.io', roleKey: 'viewer' },
    });
  });

  it('AC1: member invite honors the --project override', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { outcome: 'INVITED', emailed: true, invitePath: '/invite/abc' },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'viewer', '--project', 'other'])
      .catch(() => undefined);
    expect(projectInvitesControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'other' },
      body: { email: 'n@x.io', roleKey: 'viewer' },
    });
  });

  it('AC2: member invite prints a share-once link when the invite was not emailed', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: {
        outcome: 'INVITED',
        emailed: false,
        invitePath: '/invite/abc',
        invite: { id: 'i1', email: 'n@x.io', roleKey: 'developer', roleName: 'Developer', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER'])
      .catch(() => undefined);
    expect(loggedText()).toContain('Invite created for n@x.io. Share this link (shown once): /invite/abc');
  });

  it('AC3: member invite reports the email was sent when emailed is true', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: {
        outcome: 'INVITED',
        emailed: true,
        invitePath: '/invite/abc',
        invite: { id: 'i1', email: 'n@x.io', roleKey: 'developer', roleName: 'Developer', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER'])
      .catch(() => undefined);
    const lines = logLines();
    expect(lines).toContain('Invite created for n@x.io. Emailed.');
    expect(lines).not.toContain('Invite created for n@x.io. Share this link (shown once): /invite/abc');
  });

  it('AC5: member invite --json prints the result as indented JSON', async () => {
    const data = {
      outcome: 'INVITED',
      emailed: false,
      invitePath: '/invite/abc',
      invite: { id: 'i1', email: 'n@x.io', roleKey: 'developer', roleName: 'Developer', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
    };
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER', '--json'])
      .catch(() => undefined);
    expect(logLines()).toContain(JSON.stringify(data, null, 2));
  });

  it('AC-9: member invites shows an invite\'s role name', async () => {
    (projectInvitesControllerList as jest.Mock).mockResolvedValue({
      ret: 0,
      data: [
        {
          id: 'i1',
          email: 'a@x.io',
          roleKey: 'developer',
          roleName: 'Developer',
          status: 'PENDING',
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    await program.parseAsync(['node', 'koda', 'member', 'invites']).catch(() => undefined);
    const row = logLines().find((line) => line.includes('a@x.io'));
    expect(row).toBeDefined();
    expect(cellsOf(row as string)).toEqual(['i1', 'a@x.io', 'Developer', 'PENDING', '2026-01-01T00:00:00.000Z']);
  });

  it('AC-9: member invites falls back to the role key when no name is answered', async () => {
    (projectInvitesControllerList as jest.Mock).mockResolvedValue({
      ret: 0,
      data: [
        {
          id: 'i2',
          email: 'b@x.io',
          roleKey: 'triager',
          roleName: null,
          status: 'PENDING',
          expiresAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
    await program.parseAsync(['node', 'koda', 'member', 'invites']).catch(() => undefined);
    const row = logLines().find((line) => line.includes('b@x.io'));
    expect(row).toBeDefined();
    expect(cellsOf(row as string)[2]).toBe('triager');
  });

  it('AC6: member invites prints a table with ID/Email/Role/Status/Expires and one row per invite', async () => {
    (projectInvitesControllerList as jest.Mock).mockResolvedValue({
      ret: 0,
      data: [
        { id: 'i1', email: 'a@x.io', roleKey: 'developer', roleName: 'Developer', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
        { id: 'i2', email: 'b@x.io', roleKey: 'viewer', roleName: 'Viewer', status: 'ACCEPTED', expiresAt: '2026-02-01T00:00:00.000Z' },
      ],
    });
    await program.parseAsync(['node', 'koda', 'member', 'invites']).catch(() => undefined);
    const lines = logLines();
    const header = lines.find((line) => /ID\s+Email\s+Role\s+Status\s+Expires/.test(line));
    expect(header).toBeDefined();
    const rowLines = lines.filter((line) => line.includes('a@x.io') || line.includes('b@x.io'));
    expect(rowLines).toHaveLength(2);
    expect(loggedText()).toContain('i1');
    expect(loggedText()).toContain('i2');
  });

  it('AC6: member invites lists the context project', async () => {
    (projectInvitesControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: [] });
    await program.parseAsync(['node', 'koda', 'member', 'invites', '--project', 'other']).catch(() => undefined);
    expect(projectInvitesControllerList).toHaveBeenCalledWith({ path: { slug: 'other' } });
  });

  it('AC7: member invites --cancel sends slug and id to the cancel controller', async () => {
    (projectInvitesControllerCancel as jest.Mock).mockResolvedValue({ ret: 0, data: {} });
    await program.parseAsync(['node', 'koda', 'member', 'invites', '--cancel', 'i1']).catch(() => undefined);
    expect(projectInvitesControllerCancel).toHaveBeenCalledWith({ path: { slug: 'my-proj', id: 'i1' } });
  });

  it('AC8: member invites --resend sends slug and id to the resend controller', async () => {
    (projectInvitesControllerResend as jest.Mock).mockResolvedValue({
      ret: 0,
      data: {
        invite: { id: 'i1', email: 'n@x.io', roleKey: 'developer', roleName: 'Developer', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
        invitePath: '/invite/resend1',
        emailed: true,
      },
    });
    await program.parseAsync(['node', 'koda', 'member', 'invites', '--resend', 'i1']).catch(() => undefined);
    expect(projectInvitesControllerResend).toHaveBeenCalledWith({ path: { slug: 'my-proj', id: 'i1' } });
  });

  it('AC9: member invites --resend prints the returned invitePath', async () => {
    (projectInvitesControllerResend as jest.Mock).mockResolvedValue({
      ret: 0,
      data: {
        invite: { id: 'i1', email: 'n@x.io', roleKey: 'developer', roleName: 'Developer', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
        invitePath: '/invite/resend1',
        emailed: true,
      },
    });
    await program.parseAsync(['node', 'koda', 'member', 'invites', '--resend', 'i1']).catch(() => undefined);
    expect(loggedText()).toContain('/invite/resend1');
  });

  it('AC10: member invite reports an API 409 through handleApiError and exits with code 1', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockRejectedValue({ statusCode: 409, message: 'Invite already pending' });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER'])
      .catch(() => undefined);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('AC11: member add still calls projectMembersControllerAdd with the resolved slug and the role key body', async () => {
    (projectMembersControllerAdd as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { principalType: 'USER', principalId: 'u1', email: 'n@x.io', name: null, bindings: [] },
    });
    await program.parseAsync(['node', 'koda', 'member', 'add', '--email', 'n@x.io', '--role', 'developer']).catch(() => undefined);
    expect(projectMembersControllerAdd).toHaveBeenCalledWith({
      path: { slug: 'my-proj' },
      body: { email: 'n@x.io', roleKey: 'developer' },
    });
  });

  it('AC11: member add honors the --project override', async () => {
    (projectMembersControllerAdd as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { principalType: 'USER', principalId: 'u1', email: 'n@x.io', name: null, bindings: [] },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'add', '--email', 'n@x.io', '--role', 'developer', '--project', 'other'])
      .catch(() => undefined);
    expect(projectMembersControllerAdd).toHaveBeenCalledWith({
      path: { slug: 'other' },
      body: { email: 'n@x.io', roleKey: 'developer' },
    });
  });
});
