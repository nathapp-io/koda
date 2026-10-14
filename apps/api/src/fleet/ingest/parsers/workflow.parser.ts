import type { BundleFile } from '../bundle-reader';
import type { FleetJobWorkflow, FleetJobWorkflowItem } from '../../jobs/domain/fleet-job.domain';
import { INGEST_LIMITS } from '../domain/bundle-ingest.domain';
import { bool, clipString, nonNegInt, obj, parseJson, str } from './fields';

const OUTCOMES = ['ready', 'draft', 'local-only'] as const;

function parseItem(value: unknown): FleetJobWorkflowItem | null {
  const item = obj(value);
  if (!item) return null;
  const id = str(item.id, INGEST_LIMITS.shortText);
  const kind = str(item.kind, INGEST_LIMITS.shortText);
  const issue = str(item.issue, INGEST_LIMITS.reasonText);
  if (!id || !kind || !issue) return null;
  return {
    id,
    kind,
    issue,
    severity: str(item.severity, INGEST_LIMITS.shortText),
    file: str(item.file, 512),
    line: nonNegInt(item.line),
    suggestion: str(item.suggestion, INGEST_LIMITS.reasonText),
  };
}

export function parseWorkflowResult(file: BundleFile | null): FleetJobWorkflow | null {
  if (!file) return null;
  const root = obj(parseJson(file.text));
  if (!root || root.schemaVersion !== 1) return null;
  const runId = str(root.runId, INGEST_LIMITS.idText);
  const verdict = obj(root.verdict);
  if (!runId || !verdict || typeof verdict.outcome !== 'string' || !OUTCOMES.includes(verdict.outcome as typeof OUTCOMES[number])) return null;
  const workflowPassed = bool(verdict.workflowPassed);
  if (workflowPassed === null) return null;
  const reasons = Array.isArray(verdict.reasons)
    ? verdict.reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 20).map((reason) => clipString(reason, 500))
    : [];
  const openItems = Array.isArray(verdict.openItems)
    ? verdict.openItems.map(parseItem).filter((item): item is FleetJobWorkflowItem => item !== null).slice(0, 50)
    : [];
  return { runId, outcome: verdict.outcome as FleetJobWorkflow['outcome'], workflowPassed, reasons, openItems };
}
