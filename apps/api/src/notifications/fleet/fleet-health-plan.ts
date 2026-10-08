import type { RunnerCapabilities } from '../../fleet/common/protocol';
import { isExpiring } from '../../fleet/dashboard/credential-board';
import type { OpenHealthAlert } from './fleet-health-alerts.repository';
import type { HealthAlertKind } from './fleet-notification-events';

export interface HealthRunner { id: string; name: string; enabled: boolean; online: boolean; capabilities: RunnerCapabilities | null }
export interface HealthOpenRequest { kind: HealthAlertKind; subjectKey: string; runner: string; provider: string | null; expiresAt: string | null }
export interface HealthPlan { open: HealthOpenRequest[]; close: string[] }

const keyOf = (kind: HealthAlertKind, subjectKey: string): string => `${kind}|${subjectKey}`;

/**
 * Fleet S4a §2.4 (D507, D515): which health episodes to open and which open ones to close. Pure.
 * An open alert is closed when its condition no longer holds, unless the evidence is missing: offline checks
 * during the boot grace, and credential checks of a runner whose capabilities are unreadable, are "held".
 */
export function planHealthChanges(input: {
  runners: readonly HealthRunner[]; openAlerts: readonly OpenHealthAlert[]; now: Date; warnDays: number; inBootGrace: boolean;
}): HealthPlan {
  const wanted = new Map<string, HealthOpenRequest>();
  const held = new Set<string>();
  for (const r of input.runners.filter((x) => x.enabled)) {
    if (!r.online) {
      if (input.inBootGrace) held.add(keyOf('runner_offline', r.id));
      else wanted.set(keyOf('runner_offline', r.id), { kind: 'runner_offline', subjectKey: r.id, runner: r.name, provider: null, expiresAt: null });
    }
    if (r.capabilities === null) {
      input.openAlerts
        .filter((a) => a.kind === 'credential_expiring' && a.subjectKey.startsWith(`${r.id}:`))
        .forEach((a) => held.add(keyOf(a.kind, a.subjectKey)));
      continue;
    }
    for (const cred of r.capabilities.credentials.filter((c) => c.available && isExpiring(c, input.now, input.warnDays))) {
      const subjectKey = `${r.id}:${cred.providerId}`;
      wanted.set(keyOf('credential_expiring', subjectKey), {
        kind: 'credential_expiring', subjectKey, runner: r.name, provider: cred.providerId, expiresAt: cred.stored?.expires ?? null,
      });
    }
  }
  const openKeys = new Set(input.openAlerts.map((a) => keyOf(a.kind, a.subjectKey)));
  return {
    open: [...wanted.entries()].filter(([key]) => !openKeys.has(key)).map(([, req]) => req),
    close: input.openAlerts.filter((a) => !wanted.has(keyOf(a.kind, a.subjectKey)) && !held.has(keyOf(a.kind, a.subjectKey))).map((a) => a.id),
  };
}
