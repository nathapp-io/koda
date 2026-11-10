import { createHash } from 'node:crypto';
import { ValidationAppException } from '@nathapp/nestjs-common';

export const RULE_OVERRIDE_LIMITS = {
  maxFiles: 50,
  maxFileBytes: 32768,
  maxTotalBytes: 262144,
  maxContextBytes: 32768,
  maxPathLength: 200,
} as const;

export const RULE_PATH_PATTERN = /^[a-z0-9_-]+(\/[a-z0-9_-]+){0,3}\.md$/;

export interface RuleOverrideInput {
  rules: { path: string; content: string }[];
  rulesMode: 'merge' | 'replace';
  context: { content: string; mode: 'append' | 'replace' } | null;
}

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.ruleOverride');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Validate and normalize per-repository rules and optional project context. */
export function validateRuleOverride(raw: unknown): RuleOverrideInput {
  if (!isRecord(raw) || !Array.isArray(raw.rules) || raw.rules.length > RULE_OVERRIDE_LIMITS.maxFiles) fail('rules');

  const rules: RuleOverrideInput['rules'] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of raw.rules) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || entry.path.length > RULE_OVERRIDE_LIMITS.maxPathLength || !RULE_PATH_PATTERN.test(entry.path)) fail('path');
    if (paths.has(entry.path)) fail('duplicatePath');
    paths.add(entry.path);
    if (typeof entry.content !== 'string' || entry.content.length === 0 || entry.content.includes('\0') || byteLength(entry.content) > RULE_OVERRIDE_LIMITS.maxFileBytes) fail('content');
    totalBytes += byteLength(entry.content);
    rules.push({ path: entry.path, content: entry.content });
  }

  const rulesMode = raw.rulesMode === undefined ? 'merge' : raw.rulesMode;
  if (rulesMode !== 'merge' && rulesMode !== 'replace') fail('rulesMode');

  let context: RuleOverrideInput['context'] = null;
  if (raw.context !== undefined && raw.context !== null) {
    if (!isRecord(raw.context)) fail('context');
    if (typeof raw.context.content !== 'string' || raw.context.content.length === 0 || raw.context.content.includes('\0') || byteLength(raw.context.content) > RULE_OVERRIDE_LIMITS.maxContextBytes) fail('context');
    const mode = raw.context.mode === undefined ? 'append' : raw.context.mode;
    if (mode !== 'append' && mode !== 'replace') fail('contextMode');
    context = { content: raw.context.content, mode };
    totalBytes += byteLength(context.content);
  }

  if (totalBytes > RULE_OVERRIDE_LIMITS.maxTotalBytes) fail('size');
  if (rules.length === 0 && context === null) fail('empty');
  return { rules, rulesMode, context };
}

/** Hash the normalized override independent of rule input ordering. */
export function ruleOverrideSha256(input: RuleOverrideInput): string {
  const rules = [...input.rules].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const canonical = JSON.stringify({ rules, rulesMode: input.rulesMode, context: input.context });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
