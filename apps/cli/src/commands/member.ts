import { Command } from 'commander';
import {
  roleBindingsControllerRemove,
  projectMembersControllerAdd,
  projectMembersControllerList,
  projectInvitesControllerCreate,
  projectInvitesControllerList,
  projectInvitesControllerResend,
  projectInvitesControllerCancel,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';
import { parsePositiveInt } from '../utils/parse-positive-int';

/** One role chip of a member: the binding row a client edits and its display name. */
interface MemberBindingRow {
  id: string;
  roleKey: string;
  roleName: string;
}

/** A member row as `GET /projects/:slug/members` answers it (Permissions P1l US-006). */
interface MemberPrincipalRow {
  principalType: 'USER' | 'AGENT';
  principalId: string;
  email?: string | null;
  agentSlug?: string | null;
  name?: string | null;
  bindings: MemberBindingRow[];
}

interface MemberPrincipalPage {
  total: number;
  current: number;
  size?: number;
  hasNext: boolean;
  hasPrev?: boolean;
  records: MemberPrincipalRow[];
}

type InviteOutcome =
  | { outcome: 'ADDED'; member: MemberPrincipalRow }
  | { outcome: 'INVITED'; emailed?: boolean; invitePath: string; invite?: InviteRow };

interface InviteRow {
  id: string;
  email: string;
  roleKey?: string | null;
  roleName?: string | null;
  status: string;
  expiresAt: string;
}

/** The display names of a member's bindings, in the order the API sent them. */
function roleNames(member: MemberPrincipalRow): string {
  return member.bindings.map((binding) => binding.roleName).join(', ');
}

/** `member remove` reads the widest page the API serves per request. */
const MEMBER_LOOKUP_PAGE_SIZE = 100;

/**
 * The user member row for `userId`, walking the members pages until it shows up or the API says there is
 * no next page. Only a `USER` principal matches: an agent may carry the same id and its bindings are its
 * own, so a removal that matched one would revoke the wrong principal's roles.
 *
 * The walk is sound because the listing is exhaustive: the API reads a project's bindings in keyset pages
 * instead of truncating at its per-read cap, so a member cannot hide past it (F1). A caller holding only
 * project keys can use it too — unlike `GET /role-bindings`, which needs the global `role.read`.
 */
async function findMemberUser(slug: string, userId: string): Promise<MemberPrincipalRow | undefined> {
  for (let current = 1; ; current += 1) {
    const response = await projectMembersControllerList({
      path: { slug },
      query: { current, size: MEMBER_LOOKUP_PAGE_SIZE },
    });
    const page = unwrap<MemberPrincipalPage>(response);
    const found = page.records.find(
      (record) => record.principalType === 'USER' && record.principalId === userId,
    );
    if (found || !page.hasNext) return found;
  }
}

// Listing works with any project member key. Add, invite and remove write through the role bindings, so
// they need `member.add` (add, invite) or `role.binding.manage` (remove) on the caller's key.
export function memberCommand(program: Command): void {
  const member = program.command('member');
  member.description(
    'Project membership. Writes need the member.add or role.binding.manage permission (KODA_API_KEY=<key or token>).',
  );

  member
    .command('list')
    .description('List project members')
    .option('--project <slug>', 'Project slug')
    .option('--all', 'Include agent principals, not only user rows')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 20)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectMembersControllerList({
          path: { slug: ctx.projectSlug },
          query: {
            current: options.page,
            size: options.size,
            ...(options.all ? { principals: 'all' as const } : {}),
          },
        });
        const page = unwrap<MemberPrincipalPage>(response);
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(
            ['Type', 'ID', 'Email/Slug', 'Name', 'Roles'],
            page.records.map((m) => [
              m.principalType,
              m.principalId,
              m.email ?? m.agentSlug ?? '',
              m.name ?? '',
              m.bindings.map((binding) => `${binding.roleKey} (${binding.id})`).join(', '),
            ]),
          );
          if (page.hasNext) console.log(`Next: --page ${page.current + 1}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  member
    .command('add')
    .description('Add an existing user to the project by email')
    .requiredOption('--email <email>', 'Email of an existing user')
    .requiredOption('--role <key>', 'Role key to grant (for example developer, viewer, or a custom key)')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectMembersControllerAdd({
          path: { slug: ctx.projectSlug },
          body: { email: options.email, roleKey: options.role },
        });
        const added = unwrap<MemberPrincipalRow>(response);
        if (options.json) console.log(JSON.stringify(added, null, 2));
        else console.log(`Added ${added.email} as ${roleNames(added)}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, {
          notFoundMessage: `No user with email ${options.email} (or an unknown role key, or project not found)`,
        });
      }
    });

  member
    .command('invite')
    .description('Invite an email address to the project')
    .requiredOption('--email <email>', 'Email address to invite')
    .requiredOption('--role <key>', 'Role key to grant (for example developer, viewer, or a custom key)')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectInvitesControllerCreate({
          path: { slug: ctx.projectSlug },
          body: { email: options.email, roleKey: options.role },
        } as Parameters<typeof projectInvitesControllerCreate>[0]);
        const result = unwrap<InviteOutcome>(response);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.outcome === 'ADDED') {
          console.log(`Added ${result.member.email} as ${roleNames(result.member)}`);
        } else if (result.emailed) {
          console.log(`Invite created for ${options.email}. Emailed.`);
        } else {
          console.log(`Invite created for ${options.email}. Share this link (shown once): ${result.invitePath}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  member
    .command('invites')
    .description('List and manage project invites')
    .option('--project <slug>', 'Project slug')
    .option('--cancel <id>', 'Cancel a pending invite')
    .option('--resend <id>', 'Resend an invite')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        if (options.cancel && options.resend) {
          handleApiError(new Error('Choose either --cancel or --resend'), { validationError: true });
          return;
        }
        const ctx = await withContext({ projectSlug: options.project });
        if (options.cancel) {
          const response = await projectInvitesControllerCancel({ path: { slug: ctx.projectSlug, id: options.cancel } });
          const result = unwrap<unknown>(response);
          if (options.json) console.log(JSON.stringify(result, null, 2));
          else console.log(`Cancelled invite ${options.cancel}`);
        } else if (options.resend) {
          const response = await projectInvitesControllerResend({
            path: { slug: ctx.projectSlug, id: options.resend },
          } as Parameters<typeof projectInvitesControllerResend>[0]);
          const result = unwrap<{ invitePath: string }>(response);
          if (options.json) console.log(JSON.stringify(result, null, 2));
          else console.log(result.invitePath);
        } else {
          const response = await projectInvitesControllerList({ path: { slug: ctx.projectSlug } });
          const invites = unwrap<InviteRow[]>(response);
          if (options.json) console.log(JSON.stringify(invites, null, 2));
          else table(['ID', 'Email', 'Role', 'Status', 'Expires'], invites.map((invite) => [
            invite.id,
            invite.email,
            invite.roleName ?? invite.roleKey ?? '',
            invite.status,
            invite.expiresAt,
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  member
    .command('remove <userId>')
    .description('Remove a member from the project')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (userId: string, options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const target = await findMemberUser(ctx.projectSlug, userId);
        if (!target) return handleApiError(new Error(`Not a member: ${userId}`));
        // Deliberately not atomic: a refused delete stops the loop and the deletes
        // that already happened stay done.
        for (const binding of target.bindings) {
          await roleBindingsControllerRemove({ path: { id: binding.id } });
        }
        if (options.json) console.log(JSON.stringify({ removed: userId }, null, 2));
        else console.log(`Removed ${userId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
