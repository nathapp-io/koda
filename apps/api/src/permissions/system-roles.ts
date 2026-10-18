import type { RoleSeed } from './permissions.types';

/**
 * Permissions P1a: the eleven roles every installation starts with (design §"Seeded system roles").
 *
 * Every role is a system role; `owner` is also locked, which makes the seeder restore its entries on
 * every bootstrap. An unlocked system role keeps whatever permissions an admin has edited into it.
 *
 * The seeded `agent` role deliberately leaves out the design's `mcp.access`: that key is implicit —
 * every authenticated principal holds it and no role can grant or remove it.
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
      'fleet.schedule.*',
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
    ],
  },
  {
    key: 'approver',
    name: 'Approver',
    scope: 'PROJECT',
    permissions: ['*.read', 'approval.decide'],
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
    ],
  },
];
