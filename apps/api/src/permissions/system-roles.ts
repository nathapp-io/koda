import type { RoleSeed } from './permissions.types';

/**
 * Permissions P1a: the eleven roles every installation starts with (design §"Seeded system roles").
 *
 * Every role is a system role; `owner` is also locked, which makes the seeder restore its entries on
 * every bootstrap. An unlocked system role keeps whatever permissions an admin has edited into it.
 *
 * The seeded `agent` role deliberately leaves out the design's `mcp.access`: that key is implicit —
 * every authenticated principal holds it and no role can grant or remove it.
 *
 * The six non-admin project roles exclude `project.ci-token.read` and `invite.read` explicitly: both
 * are project secrets, so `*.read` must not reach them and only `project-admin` holds them (through
 * `*`). The seeder writes these entries when it creates a role; it never rewrites an unlocked role
 * that already exists, so an existing installation keeps its stored list until it is reset.
 */
export const SYSTEM_ROLES: readonly RoleSeed[] = [
  {
    key: 'owner',
    name: 'Owner',
    scope: 'GLOBAL',
    locked: true,
    permissions: ['*'],
  },
  {
    key: 'admin',
    name: 'Admin',
    scope: 'GLOBAL',
    permissions: ['*', '!role.binding.owner'],
  },
  {
    key: 'member',
    name: 'Member',
    scope: 'GLOBAL',
    permissions: [
      'agent.read',
      'thread.workspace.read.own',
      'thread.workspace.create',
      'thread.workspace.message.send.own',
      'thread.workspace.archive.own',
    ],
  },
  {
    key: 'agent',
    name: 'Agent',
    scope: 'GLOBAL',
    permissions: ['agent.read'],
  },
  {
    key: 'project-admin',
    name: 'Project Admin',
    scope: 'PROJECT',
    permissions: ['*', 'approval.decide', 'approval.policy.manage'],
  },
  {
    key: 'developer',
    name: 'Developer',
    scope: 'PROJECT',
    permissions: [
      '*.read',
      'ticket.create',
      'ticket.update',
      'ticket.assign',
      'ticket.transition.*',
      'ticket.label.*',
      'ticket.link.add',
      'ticket.link.remove.own',
      'ticket.watch.*',
      'comment.create',
      'comment.update.own',
      'comment.delete.own',
      'label.create',
      'label.update',
      'agent.pickup',
      'fleet.job.*',
      // Schedule edits stay owner-or-admin (P1d ruling): a developer administers only its own
      // schedules; `project-admin` holds the any-row keys through `*`.
      'fleet.schedule.read',
      'fleet.schedule.create',
      'fleet.schedule.update.own',
      'fleet.schedule.delete.own',
      'fleet.repo.drift.check',
      'fleet.ticket-job.*',
      'fleet.approval.decide.bash',
      'fleet.knowledge.repo.reindex',
      'thread.create',
      'thread.*.own',
      'kb.document.add',
      'kb.document.delete.own',
      'kb.search',
      'memory.create',
      'memory.extract',
      'memory.decision.record',
      'memory.update.own',
      'codeintel.*',
      'context.*',
      '!project.ci-token.read',
      '!invite.read',
    ],
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    scope: 'PROJECT',
    permissions: [
      '*.read',
      'comment.create',
      'comment.update.own',
      'comment.delete.own',
      'ticket.transition.verify-fix.*',
      'ticket.transition.close',
      'agent.pickup',
      'approval.decide',
      '!project.ci-token.read',
      '!invite.read',
    ],
  },
  {
    key: 'verifier',
    name: 'Verifier',
    scope: 'PROJECT',
    permissions: [
      '*.read',
      'comment.create',
      'comment.update.own',
      'comment.delete.own',
      'ticket.transition.verify',
      'ticket.transition.verify-fix.*',
      'agent.pickup',
      '!project.ci-token.read',
      '!invite.read',
    ],
  },
  {
    key: 'triager',
    name: 'Triager',
    scope: 'PROJECT',
    permissions: [
      '*.read',
      'comment.create',
      'comment.update.own',
      'comment.delete.own',
      'ticket.update',
      'ticket.assign',
      'ticket.transition.verify',
      'ticket.transition.reject',
      'ticket.label.*',
      'label.create',
      'agent.pickup',
      '!project.ci-token.read',
      '!invite.read',
    ],
  },
  {
    key: 'approver',
    name: 'Approver',
    scope: 'PROJECT',
    permissions: ['*.read', 'approval.decide', '!project.ci-token.read', '!invite.read'],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    scope: 'PROJECT',
    permissions: [
      '*.read',
      'comment.create',
      'comment.update.own',
      'comment.delete.own',
      'ticket.watch.*',
      '!project.ci-token.read',
      '!invite.read',
    ],
  },
];
