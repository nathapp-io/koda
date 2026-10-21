/**
 * Permissions P1a: the code-backed permission catalog (design
 * `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` §1, Appendix A).
 *
 * Every route, tool and system writer declares a key from this catalog; roles are bundles of these
 * keys and nothing else. The keys and their `catalog_scope` column come from
 * `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` (212 keys), plus the nine keys
 * the design adds on top. `INVENTORY_SCOPE_ROWS` is that TSV data in file order, and
 * `catalog.spec.ts` re-reads the TSV to prove the two cannot drift.
 *
 * The derivation below is executable on purpose: `access`, `scope`, `ownable` and `risk` are computed
 * from the documented rules rather than hand-assigned per key, so a rule that changes in the design
 * changes the whole catalog (and the spec that re-derives it from the TSV).
 */

export type ApprovalMode = 'none' | 'self' | 'agent' | 'human';
export type KeyScope = 'global' | 'project' | 'any';
export type PermissionAccess = 'role' | 'implicit' | 'public' | 'runner' | 'system';
export type PermissionRisk = 'low' | 'medium' | 'high' | 'critical';
export type PermissionPrincipal = 'user' | 'agent';

/** The raw `catalog_scope` vocabulary of the action inventory. */
export type InventoryScope = 'global' | 'project' | 'runner' | 'system' | 'public' | 'implicit' | 'own';

export interface PermissionCatalogEntry {
  /** `resource.verb[.qualifier]`. */
  key: string;
  scope: KeyScope;
  access: PermissionAccess;
  risk: PermissionRisk;
  principals: readonly PermissionPrincipal[];
  ownable: boolean;
  /** Placeholder until phase P3 decides floors and defaults. */
  approval: { approvable: boolean; floor: ApprovalMode; default: ApprovalMode };
}

/** Keys that need no authentication at all. */
export const PUBLIC_KEYS: ReadonlySet<string> = new Set([
  'session.login',
  'session.refresh',
  'auth.register',
  'auth.registration.read',
  'health.read',
  'invite.preview',
  'invite.accept',
  'ci.webhook.ingest',
  'vcs.webhook.ingest',
]);

/** Keys every authenticated principal holds on its own data; they cannot be removed by role edits. */
export const IMPLICIT_KEYS: ReadonlySet<string> = new Set([
  'auth.me.read',
  'session.logout',
  'home.read',
  'notification.read',
  'notification.mark-read',
  'notification.preference.read',
  'notification.preference.update',
  'agent.self.read',
  'assistant.action.read',
  'mcp.access',
]);

/**
 * Keys a role may grant as `X.own` (the action is allowed only on rows the caller created) instead
 * of the any-row key, which is implied by holding `X`. Keys that create a row are not ownable: there
 * is no owner to compare yet.
 */
export const OWNABLE_KEYS: ReadonlySet<string> = new Set([
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
  // Permissions P1d US-001: a developer edits and deletes only the schedules it created; a project
  // admin holds the any-row keys through `*`.
  'fleet.schedule.update',
  'fleet.schedule.delete',
]);

/** Keys the design adds on top of the TSV, with the scope it gives them. */
const NEW_KEY_SCOPES: Readonly<Record<string, KeyScope>> = {
  'role.read': 'global',
  'role.manage': 'global',
  'role.binding.global': 'global',
  'role.binding.owner': 'global',
  'approval.decide': 'project',
  'approval.policy.read': 'project',
  'approval.policy.manage': 'any',
  'audit.read': 'global',
  'memory.update': 'any',
};

const NEW_KEYS: readonly string[] = Object.keys(NEW_KEY_SCOPES);

/** The only key a non-user principal can never hold. */
export const OWNER_BINDING_KEY = 'role.binding.owner';

/** Write prefixes the design marks high risk beyond their verb (`vcs.connection.`, runners, ...). */
const HIGH_RISK_PREFIXES: readonly string[] = [
  'vcs.connection.',
  'vcs.webhook-secret.',
  'webhook.',
  'fleet.repo.',
  'fleet.runner.',
  'fleet.budget.',
  'fleet.enrollment.',
  'fleet.credential.',
];

/**
 * `proposed_key` → `catalog_scope` from
 * `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`, in file order, with the
 * duplicate rows of a key collapsed into one scope list. A cell holding several keys is split on `;`.
 */
const INVENTORY_SCOPE_ROWS: Readonly<Record<string, readonly InventoryScope[]>> = {
  'agent.create': ['global'],
  'agent.read': ['global', 'project'],
  'agent.self.read': ['own'],
  'agent.pickup': ['project'],
  'agent.update': ['global'],
  'agent.capabilities.update': ['global'],
  'agent.delete': ['global'],
  'agent.key.rotate': ['global'],
  'auth.register': ['public'],
  'auth.registration.read': ['public'],
  'session.login': ['public'],
  'session.refresh': ['public'],
  'auth.me.read': ['own'],
  'session.logout': ['own'],
  'ci.webhook.ingest': ['public'],
  'codeintel.index.write': ['project'],
  'codeintel.read': ['project'],
  'comment.create': ['project'],
  'comment.read': ['project'],
  'comment.update': ['global'],
  'comment.delete': ['global'],
  'context.read': ['project'],
  'context.query': ['project'],
  'fleet.activity.read': ['project'],
  'fleet.analytics.read': ['global', 'project'],
  'fleet.analytics.delete': ['global'],
  'fleet.approval.read': ['global', 'project'],
  'fleet.approval.decide.budget': ['global', 'project'],
  'fleet.approval.decide.bash': ['project'],
  'fleet.approval.decide.assistant': ['project'],
  'runner.bundle.upload': ['runner'],
  'fleet.job.bundle.read': ['project'],
  'mcp.access': ['implicit'],
  'runner.tool.call': ['runner'],
  'fleet.budget.read': ['global', 'project'],
  'fleet.budget.create': ['global', 'project'],
  'fleet.budget.update': ['global', 'project'],
  'fleet.budget.delete': ['global', 'project'],
  'fleet.budget.resume': ['global', 'project'],
  'fleet.credential.read': ['global'],
  'fleet.dashboard.read': ['global', 'project'],
  'fleet.ingest.read': ['global'],
  'fleet.ingest.backfill': ['global'],
  'fleet.ingest.rerun': ['global'],
  'fleet.job.dispatch': ['project'],
  'fleet.job.cancel': ['project'],
  'fleet.job.requeue': ['project'],
  'fleet.job.read': ['project'],
  'fleet.knowledge.read': ['project'],
  'fleet.knowledge.patterns.update': ['project'],
  'fleet.knowledge.repo.reindex': ['project'],
  'fleet.job.logs.read': ['project'],
  'runner.log.append': ['runner'],
  'testhook.nax-files.seed': ['global'],
  'fleet.job.config.read': ['project'],
  'fleet.repo.config.read': ['project'],
  'fleet.job.config.edit': ['project'],
  'fleet.repo.drift.check': ['project'],
  'runner.config.read': ['runner'],
  'fleet.repo.read': ['global', 'project'],
  'fleet.repo.create': ['global'],
  'fleet.repo.check': ['global'],
  'fleet.repo.delete': ['global'],
  'fleet.enrollment.create': ['global'],
  'fleet.enrollment.read': ['global'],
  'fleet.runner.read': ['runner', 'project'],
  'runner.enroll': ['runner'],
  'runner.self.read': ['runner'],
  'fleet.runner.update': ['runner'],
  'fleet.runner.delete': ['runner'],
  'testhook.schedule.fire': ['global'],
  'fleet.schedule.read': ['project'],
  'fleet.schedule.create': ['project'],
  'fleet.schedule.update': ['project'],
  'fleet.schedule.delete': ['project'],
  'runner.sync': ['runner', 'project'],
  'thread.create': ['project'],
  'thread.read': ['project'],
  'thread.cap.update': ['project', 'own'],
  'thread.plan': ['project'],
  'thread.run': ['project'],
  'thread.stop': ['project', 'own'],
  'thread.end-session': ['project', 'own'],
  'thread.answer': ['project', 'own'],
  'thread.archive': ['project'],
  'thread.publish': ['project'],
  'thread.discard': ['project'],
  'thread.message.send': ['project'],
  'thread.workspace.create': ['own'],
  'thread.workspace.read': ['own'],
  'thread.workspace.message.send': ['own'],
  'thread.workspace.archive': ['own'],
  'fleet.ticket-job.read': ['project'],
  'fleet.ticket-job.unlink': ['project'],
  'health.read': ['public'],
  'home.read': ['own'],
  'label.create': ['project'],
  'label.read': ['project'],
  'label.update': ['project'],
  'label.delete': ['project'],
  'ticket.label.assign': ['project'],
  'ticket.label.remove': ['project'],
  'memory.read': ['project'],
  'memory.extract': ['own'],
  'memory.decision.record': ['project', 'own'],
  'memory.create': ['project', 'own'],
  'timeline.read': ['project'],
  'admin.slo.read': ['global'],
  'notification.read': ['own'],
  'notification.mark-read': ['own'],
  'notification.preference.read': ['own'],
  'notification.preference.update': ['own'],
  'ticket.watch.read': ['project'],
  'ticket.watch.set': ['project'],
  'ticket.watch.unset': ['project'],
  'outbox.read': ['global'],
  'outbox.retry': ['global'],
  'project.assignee.read': ['project'],
  'invite.read': ['project'],
  'invite.create': ['project'],
  'invite.resend': ['project'],
  'invite.cancel': ['project'],
  'invite.preview': ['public'],
  'invite.accept': ['public'],
  'member.read': ['project'],
  'member.add': ['project'],
  // The members PATCH route folded `member.role.update` into `role.binding.manage` (US-001).
  'role.binding.manage': ['project'],
  'member.remove': ['project'],
  'project.create': ['global'],
  'project.read': ['global', 'project'],
  'project.ci-token.read': ['project'],
  'project.update': ['project'],
  'project.delete': ['project'],
  'codeintel.impact.read': ['project'],
  'project.agent.read': ['project'],
  'kb.document.add': ['project'],
  'kb.read': ['project'],
  'kb.document.delete': ['project'],
  'kb.search': ['project'],
  'kb.graphify.import': ['project'],
  'kb.optimize': ['project'],
  'retrieval.evaluate': ['project'],
  'skill.source.read': ['global'],
  'skill.source.create': ['global'],
  'skill.source.update': ['global'],
  'skill.source.delete': ['global'],
  'skill.project.read': ['project'],
  'skill.project.enable': ['project'],
  'skill.project.disable': ['project'],
  'ticket.link.add': ['project'],
  'ticket.link.read': ['project'],
  'ticket.link.remove': ['project'],
  'ticket.create': ['project'],
  'ticket.read': ['project'],
  'ticket.update': ['project'],
  'ticket.delete': ['project'],
  'ticket.assign': ['project'],
  'ticket.transition.verify': ['project'],
  'ticket.transition.start': ['project'],
  'ticket.transition.fix': ['project'],
  'ticket.transition.verify-fix.approve': ['project'],
  'ticket.transition.verify-fix.return': ['project'],
  'ticket.transition.close': ['project'],
  'ticket.transition.reject': ['project'],
  'user.read': ['global'],
  'user.create': ['global'],
  'user.update': ['global'],
  'vcs.webhook.ingest': ['public'],
  'vcs.connection.create': ['project'],
  'vcs.connection.read': ['project'],
  'vcs.connection.update': ['project'],
  'vcs.connection.delete': ['project'],
  'vcs.connection.test': ['project'],
  'vcs.webhook-secret.rotate': ['project'],
  'vcs.sync.issue': ['project'],
  'vcs.sync.all': ['project'],
  'vcs.sync.pr': ['project'],
  'webhook.create': ['project'],
  'webhook.read': ['project'],
  'webhook.update': ['project'],
  'webhook.delete': ['global', 'project'],
  'assistant.action.read': ['implicit'],
  'system.email.dispatch': ['system'],
  'system.approval.expire': ['system'],
  'system.assistant-action.expire': ['system'],
  'system.budget.window-reset': ['system'],
  'system.ingest.drain': ['system'],
  'system.knowledge.poll': ['system'],
  'system.knowledge.index': ['system'],
  'system.log.retention': ['system'],
  'system.enrollment.retention': ['system'],
  'system.schedule.dispatch': ['system'],
  'system.job.crash-silent-runner': ['system'],
  'system.ticket-link.pr-refresh': ['system'],
  'system.health.detect': ['system'],
  'system.memory.govern': ['system'],
  'system.notification.retention': ['system'],
  'system.outbox.retention': ['system'],
  'system.rag.optimize': ['system'],
  'system.vcs.poll-issues': ['system'],
  'system.vcs.pr-merge-transition': ['system'],
  'system.vcs.webhook-intake': ['system'],
  'system.ci.ticket-create': ['system'],
  'system.webhook.deliver': ['system'],
  'system.memory.extract-from-event': ['system'],
  'system.kb.ticket-index': ['system'],
  'system.entity-graph.write': ['system'],
  'system.codeintel.index-commit': ['system'],
  'system.notification.ticket': ['system'],
  'system.notification.fleet': ['system'],
  'system.thread.ingest': ['system'],
  'system.outbox.dispatch': ['system'],
};

/** Rules 1-4: what kind of principal a key belongs to. Everything else is a role key. */
function classifyAccess(key: string): PermissionAccess {
  if (key.startsWith('runner.')) return 'runner';
  if (key.startsWith('system.')) return 'system';
  if (PUBLIC_KEYS.has(key)) return 'public';
  if (IMPLICIT_KEYS.has(key)) return 'implicit';
  return 'role';
}

/**
 * Scope for a role key: ownable keys are scope-agnostic (`any`), and otherwise only the TSV's
 * `project` rows and its `global`/`runner` rows are read. `system`, `public` and `implicit` rows say
 * nothing about a role, and an `own` row means the key can be granted for the caller's own rows in
 * either role scope.
 */
function deriveScope(key: string, access: PermissionAccess, ownable: boolean): KeyScope {
  if (access !== 'role' || ownable) return 'any';

  const rows = INVENTORY_SCOPE_ROWS[key];
  if (rows === undefined) {
    const declared = NEW_KEY_SCOPES[key];
    if (declared === undefined) {
      throw new Error(`permission catalog: '${key}' has no inventory row and no declared scope`);
    }
    return declared;
  }

  const global = rows.includes('global') || rows.includes('runner');
  const project = rows.includes('project');
  if (rows.includes('own') || (global && project)) return 'any';
  if (project) return 'project';
  if (global) return 'global';
  return 'any';
}

/** Risk, first match wins: role and policy keys, then reads, then deletes/removes and high-risk writes. */
function classifyRisk(key: string): PermissionRisk {
  if (key.startsWith('role.') || key.startsWith('approval.policy.')) return 'critical';
  const last = key.slice(key.lastIndexOf('.') + 1);
  if (last === 'read') return 'low';
  if (last === 'delete' || last === 'remove') return 'high';
  if (HIGH_RISK_PREFIXES.some((prefix) => key.startsWith(prefix))) return 'high';
  return 'medium';
}

function buildEntry(key: string): PermissionCatalogEntry {
  const access = classifyAccess(key);
  const ownable = access === 'role' && OWNABLE_KEYS.has(key);
  const risk = classifyRisk(key);

  return {
    key,
    scope: deriveScope(key, access, ownable),
    access,
    risk,
    principals: key === OWNER_BINDING_KEY ? ['user'] : ['user', 'agent'],
    ownable,
    approval: { approvable: access === 'role' && risk !== 'low', floor: 'none', default: 'none' },
  };
}

const CATALOG_KEYS: readonly string[] = [...Object.keys(INVENTORY_SCOPE_ROWS), ...NEW_KEYS];

/** Every key, in inventory order followed by the keys the design adds. */
export const PERMISSION_CATALOG: readonly PermissionCatalogEntry[] = CATALOG_KEYS.map(buildEntry);

const CATALOG_BY_KEY: ReadonlyMap<string, PermissionCatalogEntry> = new Map(
  PERMISSION_CATALOG.map((entry) => [entry.key, entry]),
);

export function findCatalogEntry(key: string): PermissionCatalogEntry | undefined {
  return CATALOG_BY_KEY.get(key);
}
