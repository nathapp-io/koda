import { parsePrd } from '../prd';
import type { Verdict } from './run-verdict';

export interface PlanCheck {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly branchName: string | null;
}

/** nax can exit 0 after writing an invalid PRD, so the file is checked, not the exit code (S1 spec §5.2). */
export function checkPlanPrd(text: string | null): PlanCheck {
  if (text === null) return { ok: false, reason: 'no prd.json produced', branchName: null };
  const prd = parsePrd(text);
  if (!prd) return { ok: false, reason: 'prd.json is not valid JSON', branchName: null };
  if (prd.stories === 0) return { ok: false, reason: 'prd.json has no userStories', branchName: prd.branchName };
  return { ok: true, reason: null, branchName: prd.branchName };
}

export function planVerdict(input: { cancelRequested: boolean; check: PlanCheck }): Verdict {
  if (input.cancelRequested) return { state: 'CANCELLED', reason: null };
  return input.check.ok ? { state: 'COMPLETED', reason: null } : { state: 'FAILED', reason: input.check.reason };
}
