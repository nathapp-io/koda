jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectMembersControllerList: jest.fn(),
  projectMembersControllerAdd: jest.fn(),
  projectMembersControllerUpdateRole: jest.fn(),
  projectMembersControllerRemove: jest.fn(),
  projectInvitesControllerCreate: jest.fn(),
  projectInvitesControllerList: jest.fn(),
  projectInvitesControllerResend: jest.fn(),
  projectInvitesControllerCancel: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { memberCommand } from './member';
import {
  projectMembersControllerAdd,
  projectMembersControllerList,
  projectMembersControllerRemove,
  projectMembersControllerUpdateRole,
  projectInvitesControllerCreate,
  projectInvitesControllerList,
  projectInvitesControllerResend,
  projectInvitesControllerCancel,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'k', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

function logLines(): string[] {
  return (console.log as jest.Mock).mock.calls.map((call) => String(call[0]));
}

function loggedText(): string {
  return logLines().join('\n');
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
  // Existing member behaviour (must keep passing)
  // ---------------------------------------------------------------------------

  it('list pages members of the context project', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: { total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] } });
    await program.parseAsync(['node', 'koda', 'member', 'list', '--page', '2']);
    expect(projectMembersControllerList).toHaveBeenCalledWith({ path: { slug: 'my-proj' }, query: { current: 2, size: 20 } });
  });

  it('add sends email and role', async () => {
    (projectMembersControllerAdd as jest.Mock).mockResolvedValue({ ret: 0, data: { userId: 'u1', email: 'a@k.t', role: 'DEVELOPER' } });
    await program.parseAsync(['node', 'koda', 'member', 'add', '--email', 'a@k.t', '--role', 'DEVELOPER']);
    expect(projectMembersControllerAdd).toHaveBeenCalledWith({ path: { slug: 'my-proj' }, body: { email: 'a@k.t', role: 'DEVELOPER' } });
  });

  it('role changes a member role', async () => {
    (projectMembersControllerUpdateRole as jest.Mock).mockResolvedValue({ ret: 0, data: { userId: 'u1', email: 'a@k.t', role: 'VIEWER' } });
    await program.parseAsync(['node', 'koda', 'member', 'role', 'u1', '--role', 'VIEWER']);
    expect(projectMembersControllerUpdateRole).toHaveBeenCalledWith({ path: { slug: 'my-proj', userId: 'u1' }, body: { role: 'VIEWER' } });
  });

  it('remove targets the --project override', async () => {
    (projectMembersControllerRemove as jest.Mock).mockResolvedValue({ ret: 0, data: {} });
    await program.parseAsync(['node', 'koda', 'member', 'remove', 'u1', '--project', 'other']);
    expect(projectMembersControllerRemove).toHaveBeenCalledWith({ path: { slug: 'other', userId: 'u1' } });
  });

  // ---------------------------------------------------------------------------
  // US-006 — invite / invites commands
  // ---------------------------------------------------------------------------

  it('AC1: member invite sends the context project slug and the email/role body', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { outcome: 'INVITED', emailed: true, invitePath: '/invite/abc' },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER'])
      .catch(() => undefined);
    expect(projectInvitesControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'my-proj' },
      body: { email: 'n@x.io', role: 'DEVELOPER' },
    });
  });

  it('AC1: member invite honors the --project override', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { outcome: 'INVITED', emailed: true, invitePath: '/invite/abc' },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER', '--project', 'other'])
      .catch(() => undefined);
    expect(projectInvitesControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'other' },
      body: { email: 'n@x.io', role: 'DEVELOPER' },
    });
  });

  it('AC2: member invite prints a share-once link when the invite was not emailed', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: {
        outcome: 'INVITED',
        emailed: false,
        invitePath: '/invite/abc',
        invite: { id: 'i1', email: 'n@x.io', role: 'DEVELOPER', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
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
        invite: { id: 'i1', email: 'n@x.io', role: 'DEVELOPER', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER'])
      .catch(() => undefined);
    const lines = logLines();
    expect(lines).toContain('Invite created for n@x.io. Emailed.');
    expect(lines).not.toContain('Invite created for n@x.io. Share this link (shown once): /invite/abc');
  });

  it('AC4: member invite prints the added message when the user already existed', async () => {
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0,
      data: {
        outcome: 'ADDED',
        member: { userId: 'u1', email: 'n@x.io', role: 'DEVELOPER' },
      },
    });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER'])
      .catch(() => undefined);
    expect(loggedText()).toContain('Added n@x.io as DEVELOPER');
  });

  it('AC5: member invite --json prints the result as indented JSON', async () => {
    const data = {
      outcome: 'INVITED',
      emailed: false,
      invitePath: '/invite/abc',
      invite: { id: 'i1', email: 'n@x.io', role: 'DEVELOPER', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
    };
    (projectInvitesControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data });
    await program
      .parseAsync(['node', 'koda', 'member', 'invite', '--email', 'n@x.io', '--role', 'DEVELOPER', '--json'])
      .catch(() => undefined);
    expect(logLines()).toContain(JSON.stringify(data, null, 2));
  });

  it('AC6: member invites prints a table with ID/Email/Role/Status/Expires and one row per invite', async () => {
    (projectInvitesControllerList as jest.Mock).mockResolvedValue({
      ret: 0,
      data: [
        { id: 'i1', email: 'a@x.io', role: 'DEVELOPER', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
        { id: 'i2', email: 'b@x.io', role: 'VIEWER', status: 'ACCEPTED', expiresAt: '2026-02-01T00:00:00.000Z' },
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
        invite: { id: 'i1', email: 'n@x.io', role: 'DEVELOPER', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
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
        invite: { id: 'i1', email: 'n@x.io', role: 'DEVELOPER', status: 'PENDING', expiresAt: '2026-01-01T00:00:00.000Z' },
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

  it('AC11: member add still calls projectMembersControllerAdd with the resolved slug and body', async () => {
    (projectMembersControllerAdd as jest.Mock).mockResolvedValue({ ret: 0, data: { userId: 'u1', email: 'n@x.io', role: 'DEVELOPER' } });
    await program.parseAsync(['node', 'koda', 'member', 'add', '--email', 'n@x.io', '--role', 'DEVELOPER']).catch(() => undefined);
    expect(projectMembersControllerAdd).toHaveBeenCalledWith({
      path: { slug: 'my-proj' },
      body: { email: 'n@x.io', role: 'DEVELOPER' },
    });
  });

  it('AC11: member add honors the --project override', async () => {
    (projectMembersControllerAdd as jest.Mock).mockResolvedValue({ ret: 0, data: { userId: 'u1', email: 'n@x.io', role: 'DEVELOPER' } });
    await program
      .parseAsync(['node', 'koda', 'member', 'add', '--email', 'n@x.io', '--role', 'DEVELOPER', '--project', 'other'])
      .catch(() => undefined);
    expect(projectMembersControllerAdd).toHaveBeenCalledWith({
      path: { slug: 'other' },
      body: { email: 'n@x.io', role: 'DEVELOPER' },
    });
  });
});
