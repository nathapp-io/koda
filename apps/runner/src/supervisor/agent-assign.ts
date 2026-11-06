import type { AgentAssign } from '@nathapp/fleet-protocol';

/**
 * fleet-agent-job US-007: the bounds of an AGENT job's input. They mirror the API
 * (`apps/api/src/fleet/common/agent-jobs.ts`) and, through it, nax's `config/schemas-model-alias.ts`, and are copied
 * here on purpose: the runner re-validates what the server sends and imports no business rule from `apps/api` (D30).
 */
export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const AGENT_TASK_MAX_CHARS = 16_384;
export const AGENT_MODEL_MAX_CHARS = 200;
export const AGENT_MODEL_ALIAS_MAX_ENTRIES = 8;
export const AGENT_MODEL_ALIAS_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `provider/model` or `acp:<claude|codex|cursor>[/<model>]`, an optional `[effort]`, and never a whitespace. */
export const AGENT_MODEL_ALIAS_TARGET_RE = /^(?:(?!acp:)[^\s/\x5B\x5D]+\/[^\s/\x5B\x5D]+(?:\[[^\s\x5B\x5D]+\])?|acp:(?:claude|codex|cursor)(?:\/[^\s/\x5B\x5D]+)?(?:\[[^\s\x5B\x5D]+\])?)$/;
export const AGENT_TIMEOUT_MIN_SEC = 60;
export const AGENT_TIMEOUT_MAX_SEC = 86_400;

/** A NUL reaches a jsonb column or a file the same way it reaches a database error: never let one through. */
const hasNul = (value: string): boolean => value.includes('\u0000');

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isModelAliasTarget = (value: unknown): value is string =>
  typeof value === 'string' && !hasNul(value) && AGENT_MODEL_ALIAS_TARGET_RE.test(value);

/** A rebuilt aliases map: only a valid key and a valid nax target survive, so an odd entry refuses the whole block. */
function cleanModelAliases(raw: unknown): Record<string, string> | null {
  if (!isObject(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > AGENT_MODEL_ALIAS_MAX_ENTRIES) return null;
  const aliases: Record<string, string> = {};
  for (const [key, target] of entries) {
    if (!AGENT_MODEL_ALIAS_KEY_RE.test(key) || !isModelAliasTarget(target)) return null;
    aliases[key] = target;
  }
  return aliases;
}

/**
 * The `agent` block of an AGENT ASSIGN, re-validated field by field, or null when the server sent something this
 * runner must not act on. Only validated fields are copied: the model alias map reaches nax's profile, and the task
 * becomes the job's task file (US-008).
 */
export function cleanAgentAssign(raw: unknown): AgentAssign | null {
  if (!isObject(raw)) return null;
  const { name, task, model, modelAliases, timeoutSec } = raw;
  if (typeof name !== 'string' || !AGENT_NAME_RE.test(name) || name.includes('..')) return null;
  if (typeof task !== 'string' || task.length < 1 || task.length > AGENT_TASK_MAX_CHARS || task.trim().length === 0 || hasNul(task)) return null;
  if (model !== undefined && (typeof model !== 'string' || model.length < 1 || model.length > AGENT_MODEL_MAX_CHARS || /\s/.test(model) || hasNul(model))) return null;
  const aliases = modelAliases === undefined ? undefined : cleanModelAliases(modelAliases);
  if (aliases === null) return null;
  if (timeoutSec !== undefined && (typeof timeoutSec !== 'number' || !Number.isInteger(timeoutSec) || timeoutSec < AGENT_TIMEOUT_MIN_SEC || timeoutSec > AGENT_TIMEOUT_MAX_SEC)) return null;
  return {
    name,
    task,
    ...(model === undefined ? {} : { model }),
    ...(aliases === undefined ? {} : { modelAliases: aliases }),
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
  };
}
