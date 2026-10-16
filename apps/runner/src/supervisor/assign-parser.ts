import { THREAD_LIMITS, KODA_TOOL_LIMITS, PROJECT_CODE_LIMITS, THREAD_MODEL_ID_RE, isConfigKind, type AssignPayload, type BashMode, type FleetCommandOut, type FleetJobKindName, type KodaToolDescriptor, type ProjectRepoAssign, type ProjectRepoUnavailable, type ThreadAssign, type ThreadBackend, type ThreadSkillSource } from '@nathapp/fleet-protocol';
import { assertCloneUrl } from '../executor/workspace';
import { COST_RE, PROFILE_NAME, RESERVED_PREFIX } from '../executor/nax-process';
import { PathError, assertFeature, assertOwner, assertRelativePath, assertSegment } from '../paths/safe-segment';

export type ParsedAssign = { ok: true; assign: AssignPayload } | { ok: false; detail: string };

const BASH_MODES: readonly string[] = ['raw', 'gated', 'escalate'];
const DEFAULT_APPROVAL_TIMEOUT_SEC = 600;
const INSTRUCTIONS_MAX_CHARS = 262_144;
const EFFORT_RE = /^[a-z]{1,16}$/;
const THREAD_TITLE_MAX_CHARS = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what: string): ParsedAssign => ({ ok: false, detail: `invalid ${what}` });
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const hasControl = (v: string): boolean => [...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const plain = (v: unknown, max: number): v is string => text(v, max) && !hasControl(v);

function checked(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    if (error instanceof PathError) return false;
    throw error;
  }
}

/** @design API-1: `checked`'s re-throw policy cannot be reached through `parseAssign` (all validators throw `PathError`),
 *  so it is exported under a test-only name rather than widened into the public parse surface. */
export const __checked = checked;

function cleanBackend(v: unknown): ThreadBackend | null {
  if (!isObj(v)) return null;
  const kind = v['kind'];
  const model = v['model'];
  const effort = v['effort'];
  const modelOk = model === undefined || (typeof model === 'string' && THREAD_MODEL_ID_RE.test(model));
  const effortOk = effort === undefined || (typeof effort === 'string' && EFFORT_RE.test(effort));
  if (!modelOk || !effortOk) return null;
  if (kind === 'native') {
    if (v['agent'] !== undefined) return null;
    return {
      kind: 'native',
      ...(model !== undefined ? { model: model as string } : {}),
      ...(effort !== undefined ? { effort: effort as string } : {}),
    };
  }
  if (kind === 'acp') {
    const agent = v['agent'];
    if (agent !== 'claude' && agent !== 'codex') return null;
    return {
      kind: 'acp',
      agent,
      ...(model !== undefined ? { model: model as string } : {}),
      ...(effort !== undefined ? { effort: effort as string } : {}),
    };
  }
  return null;
}

function cleanSkills(v: unknown): ThreadSkillSource[] | null {
  if (!Array.isArray(v)) return null;
  const out: ThreadSkillSource[] = [];
  for (const entry of v) {
    if (!isObj(entry)) return null;
    const sourceId = entry['sourceId'];
    const owner = entry['owner'];
    const repo = entry['repo'];
    const sha = entry['sha'];
    const skills = entry['skills'];
    if (typeof sourceId !== 'string' || typeof owner !== 'string' || typeof repo !== 'string' || typeof sha !== 'string') return null;
    if (!Array.isArray(skills)) return null;
    const cleaned: ThreadSkillSource['skills'] = [];
    for (const s of skills) {
      if (!isObj(s)) return null;
      if (typeof s['name'] !== 'string' || typeof s['dir'] !== 'string' || typeof s['description'] !== 'string') return null;
      cleaned.push({ name: s['name'] as string, dir: s['dir'] as string, description: s['description'] as string });
    }
    out.push({ sourceId: sourceId as string, owner: owner as string, repo: repo as string, sha: sha as string, skills: cleaned });
  }
  return out;
}

/** S5b §1 §"Runner (proxies)": a descriptor's description is a string of at most this many characters. */
const KODA_TOOL_DESCRIPTION_MAX_CHARS = 2_000;

/**
 * Fleet S5b US-006: the ASSIGN's koda tool descriptors are re-validated with the same limits the API's catalog
 * enforces, and only the validated fields are copied — a descriptor reaches nax-agent's tool table and the model's
 * prompt, so an odd name or a schema of another shape is refused whole (`invalid koda tools`), not trimmed.
 * An absent field is not this function's business: the caller keeps the key off the assign.
 */
function cleanKodaTools(v: unknown): KodaToolDescriptor[] | null {
  if (!Array.isArray(v) || v.length > KODA_TOOL_LIMITS.maxTools) return null;
  const out: KodaToolDescriptor[] = [];
  for (const entry of v) {
    if (!isObj(entry)) return null;
    const name = entry['name'];
    const description = entry['description'];
    const inputSchema = entry['inputSchema'];
    if (typeof name !== 'string' || !KODA_TOOL_LIMITS.nameRe.test(name)) return null;
    if (typeof description !== 'string' || description.length > KODA_TOOL_DESCRIPTION_MAX_CHARS) return null;
    if (!isObj(inputSchema)) return null;
    out.push({ name, description, inputSchema: { ...inputSchema } });
  }
  return out;
}

/** Project code is read only, and clone targets must use TLS even on a trusted ASSIGN. */
function cleanProjectRepos(v: unknown): ProjectRepoAssign[] | null {
  if (!Array.isArray(v) || v.length > PROJECT_CODE_LIMITS.maxRepos) return null;
  const out: ProjectRepoAssign[] = [];
  for (const entry of v) {
    if (!isObj(entry)) return null;
    const { repoId, owner, name, defaultBranch, cloneUrl } = entry;
    if (!text(repoId, 64) || !checked(() => assertSegment('repoId', repoId))) return null;
    if (typeof owner !== 'string' || !checked(() => assertOwner(owner))) return null;
    if (typeof name !== 'string' || !checked(() => assertSegment('repo name', name))) return null;
    if (!plain(defaultBranch, 255) || typeof cloneUrl !== 'string') return null;
    try {
      if (new URL(cloneUrl).protocol !== 'https:') return null;
    } catch {
      return null;
    }
    out.push({ repoId, owner, name, defaultBranch, cloneUrl });
  }
  return out;
}

function cleanProjectUnavailable(v: unknown): ProjectRepoUnavailable[] | null {
  if (!Array.isArray(v) || v.length > PROJECT_CODE_LIMITS.maxUnavailable) return null;
  const out: ProjectRepoUnavailable[] = [];
  for (const entry of v) {
    if (!isObj(entry)) return null;
    const { owner, name, reason } = entry;
    if (typeof owner !== 'string' || !checked(() => assertOwner(owner))) return null;
    if (typeof name !== 'string' || !checked(() => assertSegment('repo name', name))) return null;
    if (reason !== 'not a GitHub repository' && reason !== 'no installation' && reason !== 'limit') return null;
    out.push({ owner, name, reason });
  }
  return out;
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * D30: the server is trusted to deliver, not to be well formed. Every field that reaches a path, an argv or git config
 * is re-validated, and only the validated fields are copied. `ref` is only bounded here: an odd ref becomes a fixed
 * `checkout:` reason in prepare, not a rejected command.
 */
export function parseAssign(command: FleetCommandOut): ParsedAssign {
  const p = command.payload as unknown;
  if (!isObj(p)) return bad('payload');
  if (p['jobId'] !== command.jobId || !checked(() => assertSegment('jobId', p['jobId']))) return bad('jobId');
  const kind = p['command'];
  if (typeof kind !== 'string' || (kind !== 'RUN' && kind !== 'PLAN' && kind !== 'THREAD' && !isConfigKind(kind))) return bad('command');
  const isConfig = isConfigKind(kind);
  const isThread = kind === 'THREAD';
  const repo = p['repo'];
  if (!isObj(repo) || (repo['provider'] !== 'github' && repo['provider'] !== 'gitlab')) return bad('repo');
  if (!checked(() => assertOwner(repo['owner']))) return bad('owner');
  if (!checked(() => assertSegment('repo', repo['name']))) return bad('repo name');
  if (!text(repo['cloneUrl'], 2_000) || !checked(() => assertCloneUrl(repo['cloneUrl'] as string))) return bad('cloneUrl');
  if (!plain(repo['defaultBranch'], 255)) return bad('defaultBranch');
  if (!plain(p['ref'], 255)) return bad('ref');
  if (!checked(() => assertFeature(p['feature']))) return bad('feature');
  const isPlan = p['command'] === 'PLAN';
  if (isPlan ? !checked(() => assertRelativePath('planFrom', p['planFrom'])) : p['planFrom'] !== null && p['planFrom'] !== undefined) return bad('planFrom');
  const profiles = p['profiles'];
  if (isThread) {
    if (!Array.isArray(profiles) || profiles.length !== 0) return bad('profiles');
  } else if (!Array.isArray(profiles) || profiles.length > 8 || (isConfig && profiles.length > 0) || !profiles.every((n) => typeof n === 'string' && PROFILE_NAME.test(n) && !n.startsWith(RESERVED_PREFIX))) return bad('profiles');
  if (typeof p['maxCostUsd'] !== 'string' || !COST_RE.test(p['maxCostUsd'])) return bad('maxCostUsd');
  if (typeof p['bashMode'] !== 'string' || !BASH_MODES.includes(p['bashMode']) || ((isPlan || isConfig || isThread) && p['bashMode'] !== 'raw')) return bad('bashMode');
  // A server that predates S1.5 2a sends no timeout; it also only sends raw jobs.
  const approvalTimeoutSec = p['approvalTimeoutSec'] ?? DEFAULT_APPROVAL_TIMEOUT_SEC;
  if (typeof approvalTimeoutSec !== 'number' || !Number.isInteger(approvalTimeoutSec) || approvalTimeoutSec < 30 || approvalTimeoutSec > 3600) return bad('approvalTimeoutSec');
  const identity = p['gitIdentity'];
  if (!isObj(identity) || !plain(identity['name'], 200) || !plain(identity['email'], 200)) return bad('gitIdentity');
  const baseAssign = {
    jobId: p['jobId'] as string,
    command: kind as FleetJobKindName,
    repo: {
      provider: repo['provider'] as 'github' | 'gitlab', owner: repo['owner'] as string, name: repo['name'] as string,
      defaultBranch: repo['defaultBranch'] as string, cloneUrl: repo['cloneUrl'] as string,
    },
    ref: p['ref'] as string,
    feature: p['feature'] as string,
    planFrom: isPlan ? (p['planFrom'] as string) : null,
    profiles: [...(profiles as string[])],
    maxCostUsd: p['maxCostUsd'],
    bashMode: p['bashMode'] as BashMode,
    approvalTimeoutSec,
    gitIdentity: { name: identity['name'] as string, email: identity['email'] as string },
  };
  // US-005: the thread PLAN's expected branch. A PLAN-only field: any other job that carries it is refused.
  const rawExpectBranch = p['expectBranch'];
  if (rawExpectBranch !== undefined && !isPlan) return bad('expectBranch');
  if (rawExpectBranch !== undefined && !plain(rawExpectBranch, 255)) return bad('expectBranch');
  const expectBranch = rawExpectBranch === undefined ? {} : { expectBranch: rawExpectBranch as string };
  if (!isThread) {
    if (p['thread'] !== undefined) return bad('thread');
    return { ok: true, assign: { ...baseAssign, ...expectBranch } };
  }
  const t = p['thread'];
  if (!isObj(t)) return bad('thread');
  if (!checked(() => assertSegment('threadId', t['threadId']))) return bad('threadId');
  const action = t['action'];
  if (action !== 'SESSION' && action !== 'PUBLISH' && action !== 'DISCARD') return bad('thread action');
  // Fleet S5b: `kind` is optional (absent means REPO); a PROJECT thread only ever runs a SESSION.
  const rawKind = t['kind'];
  if (rawKind !== undefined && rawKind !== 'REPO' && rawKind !== 'PROJECT') return bad('thread kind');
  if (rawKind === 'PROJECT' && action !== 'SESSION') return bad('thread action');
  if (!checked(() => assertFeature(t['feature']))) return bad('thread feature');
  if (typeof t['resume'] !== 'boolean') return bad('thread resume');
  const instructions = t['instructions'];
  if (typeof instructions !== 'string' || instructions.length > INSTRUCTIONS_MAX_CHARS) return bad('instructions');
  const backend = cleanBackend(t['backend']);
  if (!backend) return bad('backend');
  const skills = cleanSkills(t['skills']);
  if (!skills) return bad('skills');
  const rawInitial = t['initialMessage'];
  let initialMessage: ThreadAssign['initialMessage'];
  if (rawInitial === null) {
    initialMessage = null;
  } else if (action !== 'SESSION') {
    return bad('initialMessage');
  } else {
    if (!isObj(rawInitial)) return bad('initialMessage');
    if (!checked(() => assertSegment('messageId', rawInitial['messageId']))) return bad('initialMessage');
    const initialText = rawInitial['text'];
    if (typeof initialText !== 'string' || initialText.length > THREAD_LIMITS.messageMaxBytes || utf8Bytes(initialText) > THREAD_LIMITS.messageMaxBytes) return bad('initialMessage');
    initialMessage = { messageId: rawInitial['messageId'] as string, text: initialText };
  }
  // The title is optional; the API bounds it at 200 characters (thread-input.ts), so it is copied only when present.
  const rawTitle = t['title'];
  if (rawTitle !== undefined && !text(rawTitle, THREAD_TITLE_MAX_CHARS)) return bad('thread title');
  // Fleet S5b: the koda tools this session may proxy. Optional — the API sends none to a runner that does not
  // advertise the capability — and an empty list is the same as none.
  const rawKodaTools = t['kodaTools'];
  const kodaTools = rawKodaTools === undefined ? undefined : cleanKodaTools(rawKodaTools);
  if (kodaTools === null) return bad('koda tools');
  const rawRepos = t['projectRepos'];
  const rawUnavailable = t['projectReposUnavailable'];
  if ((rawRepos !== undefined || rawUnavailable !== undefined) && rawKind !== 'PROJECT') return bad('project repos');
  const projectRepos = rawRepos === undefined ? undefined : cleanProjectRepos(rawRepos);
  const projectReposUnavailable = rawUnavailable === undefined ? undefined : cleanProjectUnavailable(rawUnavailable);
  if (projectRepos === null || projectReposUnavailable === null) return bad('project repos');
  const thread: ThreadAssign = {
    threadId: t['threadId'] as string,
    action,
    ...(rawKind !== undefined ? { kind: rawKind } : {}),
    feature: t['feature'] as string,
    resume: t['resume'] as boolean,
    instructions: instructions as string,
    backend,
    skills,
    initialMessage,
    ...(rawTitle !== undefined ? { title: rawTitle as string } : {}),
    ...(kodaTools === undefined ? {} : { kodaTools }),
    ...(projectRepos === undefined ? {} : { projectRepos }),
    ...(projectReposUnavailable === undefined ? {} : { projectReposUnavailable }),
  };
  return { ok: true, assign: { ...baseAssign, ...expectBranch, thread } };
}
