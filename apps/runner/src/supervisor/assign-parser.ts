import { ACP_EFFORT_RE, ACP_MODEL_ID_RE, THREAD_LIMITS, KODA_TOOL_LIMITS, PROJECT_CODE_LIMITS, THREAD_MODEL_ID_RE, isConfigKind, type AgentAssign, type AssignPayload, type BashMode, type FleetCommandOut, type FleetJobKindName, type KodaToolDescriptor, type ProjectRepoAssign, type ProjectRepoUnavailable, type RuleOverrideAssign, type ThreadAgent, type ThreadAssign, type ThreadBackend, type ThreadSkillSource, type ReviewDecision, type CallerRuling } from '@nathapp/fleet-protocol';
import { assertCloneUrl } from '../executor/workspace';
import { COST_RE, PROFILE_NAME, RESERVED_PREFIX } from '../executor/nax-process';
import { PathError, assertFeature, assertOwner, assertRelativePath, assertSegment } from '../paths/safe-segment';
import { cleanAgentAssign } from './agent-assign';

export type ParsedAssign = { ok: true; assign: AssignPayload } | { ok: false; detail: string };

const BASH_MODES: readonly string[] = ['raw', 'gated', 'escalate'];
const DEFAULT_APPROVAL_TIMEOUT_SEC = 600;
const INSTRUCTIONS_MAX_CHARS = 262_144;
const EFFORT_RE = /^[a-z]{1,16}$/;
const THREAD_TITLE_MAX_CHARS = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what: string): ParsedAssign => ({ ok: false, detail: `invalid ${what}` });
/**
 * fleet-agent-job US-007 AC-4…AC-7 name the exact detail an AGENT refusal carries — `agent` for a bad or misplaced
 * agent block, `bashMode` for a non-raw mode — so those two answer without `bad`'s `invalid ` prefix. Every other
 * kind keeps the legacy prefixed details (`invalid bashMode` included).
 */
const badAgent = (): ParsedAssign => ({ ok: false, detail: 'agent' });
const badAgentBashMode = (): ParsedAssign => ({ ok: false, detail: 'bashMode' });
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

/**
 * thread-agents-modes US-003: the ACP agents a thread may name. An exhaustive map, so a new `ThreadAgent` in
 * fleet-protocol fails to compile until it is admitted or refused here on purpose.
 */
const ACP_AGENT: Readonly<Record<ThreadAgent, true>> = { claude: true, codex: true, cursor: true };

const isThreadAgent = (v: unknown): v is ThreadAgent => typeof v === 'string' && Object.hasOwn(ACP_AGENT, v);

function cleanBackend(v: unknown): ThreadBackend | null {
  if (!isObj(v)) return null;
  const kind = v['kind'];
  const model = v['model'];
  const effort = v['effort'];
  if (kind !== 'native' && kind !== 'acp') return null;
  // thread-agents-modes US-003: an ACP model and effort id may carry what the agent advertises (`[...]`
  // option suffixes in a model, digits and dashes in an effort); a native backend keeps the narrower rules.
  // Without this split the runner refuses an ASSIGN the API accepted (thread-input.ts).
  const isAcp = kind === 'acp';
  const modelOk = model === undefined || (typeof model === 'string' && (isAcp ? ACP_MODEL_ID_RE : THREAD_MODEL_ID_RE).test(model));
  const effortOk = effort === undefined || (typeof effort === 'string' && (isAcp ? ACP_EFFORT_RE : EFFORT_RE).test(effort));
  if (!modelOk || !effortOk) return null;
  if (kind === 'native') {
    if (v['agent'] !== undefined) return null;
    return {
      kind: 'native',
      ...(model !== undefined ? { model: model as string } : {}),
      ...(effort !== undefined ? { effort: effort as string } : {}),
    };
  }
  const agent = v['agent'];
  if (!isThreadAgent(agent)) return null;
  return {
    kind: 'acp',
    agent,
    ...(model !== undefined ? { model: model as string } : {}),
    ...(effort !== undefined ? { effort: effort as string } : {}),
  };
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

function cleanReviewDecisions(v: unknown): ReviewDecision[] | null {
  if (!Array.isArray(v) || v.length > 100) return null;
  const out: ReviewDecision[] = [];
  const ids = new Set<string>();
  for (const entry of v) {
    if (!isObj(entry)) return null;
    const id = entry['id'];
    const statement = entry['statement'];
    const source = entry['source'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(id) || ids.has(id)) return null;
    if (typeof statement !== 'string' || statement.length < 1 || statement.length > 2_000) return null;
    if (source !== undefined && (typeof source !== 'string' || source.length > 200)) return null;
    ids.add(id);
    out.push({ id, statement, ...(source !== undefined ? { source } : {}) });
  }
  return out;
}

function cleanReviewRulings(v: unknown): NonNullable<NonNullable<AssignPayload['review']>['rulings']> | null {
  if (!isObj(v) || typeof v['headSha'] !== 'string' || !/^[a-fA-F0-9]{40}$/.test(v['headSha'])) return null;
  const entries = v['rulings'];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) return null;
  const rulings: CallerRuling[] = [];
  const items = new Set<string>();
  for (const entry of entries) {
    if (!isObj(entry)) return null;
    const { item, ruling, by, at } = entry;
    if (typeof item !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(item) || items.has(item)) return null;
    if (!text(ruling, 2000) || !text(by, 100) || /[\r\n]/.test(by)) return null;
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at)) return null;
    const time = Date.parse(at);
    if (!Number.isFinite(time) || time > Date.now() + 5 * 60_000) return null;
    items.add(item);
    rulings.push({ item, ruling, by, at });
  }
  return { headSha: v['headSha'], rulings };
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

/** fleet #370 (US-009): the rule override the API stores per repo and sends with the ASSIGN. */
const RULE_OVERRIDE_MAX_FILES = 50;
/** The API's rule path pattern (`apps/api/src/fleet/repos/rule-override.ts`): lowercase segments and a `.md` file. */
const RULE_PATH_RE = /^[a-z0-9_-]+(\/[a-z0-9_-]+){0,3}\.md$/;
/** The stored override's hash: lowercase hex, 64 characters. */
const RULE_SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * fleet #370 (US-009): the repo's rule override, read when the job was assigned. Only the validated fields are
 * copied; the rule path is checked against the same pattern the API validates it with, so a path that could leave
 * the rules directory never reaches the job directory.
 */
function cleanRuleOverride(v: unknown): RuleOverrideAssign | null {
  if (!isObj(v)) return null;
  const sha256 = v['sha256'];
  if (typeof sha256 !== 'string' || !RULE_SHA256_RE.test(sha256)) return null;
  const rulesMode = v['rulesMode'];
  if (rulesMode !== 'merge' && rulesMode !== 'replace') return null;
  const rawRules = v['rules'];
  if (!Array.isArray(rawRules) || rawRules.length > RULE_OVERRIDE_MAX_FILES) return null;
  const rules: { path: string; content: string }[] = [];
  for (const entry of rawRules) {
    if (!isObj(entry)) return null;
    const path = entry['path'];
    const content = entry['content'];
    if (typeof path !== 'string' || !RULE_PATH_RE.test(path)) return null;
    if (typeof content !== 'string') return null;
    rules.push({ path, content });
  }
  const rawContext = v['context'];
  let context: RuleOverrideAssign['context'];
  if (rawContext !== undefined) {
    if (!isObj(rawContext)) return null;
    const content = rawContext['content'];
    const mode = rawContext['mode'];
    if (typeof content !== 'string') return null;
    if (mode !== 'append' && mode !== 'replace') return null;
    context = { content, mode };
  }
  return { sha256, rulesMode, rules, ...(context === undefined ? {} : { context }) };
}

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
  if (typeof kind !== 'string' || (kind !== 'RUN' && kind !== 'PLAN' && kind !== 'THREAD' && kind !== 'REVIEW' && kind !== 'FIX' && kind !== 'AGENT' && !isConfigKind(kind))) return bad('command');
  const isConfig = isConfigKind(kind);
  const isThread = kind === 'THREAD';
  const isReview = kind === 'REVIEW' || kind === 'FIX';
  const isAgent = kind === 'AGENT';
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
  if (typeof p['bashMode'] !== 'string' || !BASH_MODES.includes(p['bashMode'])) return bad('bashMode');
  // AC-7: an AGENT refuses a relay mode with the exact `bashMode` detail; the mode must still be a known one.
  if (isAgent && p['bashMode'] !== 'raw') return badAgentBashMode();
  if ((isPlan || isConfig || isThread || isReview) && p['bashMode'] !== 'raw') return bad('bashMode');
  const rawReview = p['review'];
  let reviewDecisions: ReviewDecision[] | undefined;
  let reviewRulings: NonNullable<AssignPayload['review']>['rulings'];
  if (isReview) {
    if (!isObj(rawReview) || !Number.isSafeInteger(rawReview['prNumber']) || (rawReview['prNumber'] as number) <= 0 || typeof rawReview['botLogin'] !== 'string' || rawReview['botLogin'].length < 1 || rawReview['botLogin'].length > 100 || !/^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/.test(rawReview['botLogin'])) return bad('review');
    if (Object.hasOwn(rawReview, 'rulings')) {
      if (kind !== 'FIX') return bad('review');
      const cleaned = cleanReviewRulings(rawReview['rulings']);
      if (cleaned === null) return bad('review');
      reviewRulings = cleaned;
    }
    const hasTrustDetectedChecks = Object.hasOwn(rawReview, 'trustDetectedChecks');
    if (kind === 'FIX' ? hasTrustDetectedChecks && rawReview['trustDetectedChecks'] !== true : hasTrustDetectedChecks) return bad('review');
    if (rawReview['decisions'] !== undefined) {
      const cleaned = cleanReviewDecisions(rawReview['decisions']);
      if (cleaned === null) return bad('review');
      reviewDecisions = cleaned;
    }
  } else if (rawReview !== undefined) return bad('review');
  // fleet-agent-job US-007: an AGENT needs its agent block, and no other kind may carry one (the `review` and
  // `thread` precedent). An AGENT's planFrom is already refused above; a prNumber or ticketRefs never reaches an
  // ASSIGN (the API refuses them at dispatch), and any other unlisted key is dropped rather than copied.
  const rawAgent = p['agent'];
  let agent: AgentAssign | undefined;
  if (isAgent) {
    const cleaned = cleanAgentAssign(rawAgent);
    if (cleaned === null) return badAgent();
    agent = cleaned;
  } else if (rawAgent !== undefined) return badAgent();
  // fleet #370 (US-009): the repo's rule override travels with the nax commands only (RUN, PLAN, REVIEW, FIX,
  // AGENT). A THREAD turn and a config job never carry one: a thread turn is not a nax run of its own, and a config
  // job edits configuration instead of running nax. An override of any other shape is refused whole.
  const rawRuleOverride = p['ruleOverride'];
  let ruleOverride: RuleOverrideAssign | undefined;
  if (rawRuleOverride !== undefined) {
    if (isThread || isConfig) return bad('ruleOverride');
    const cleaned = cleanRuleOverride(rawRuleOverride);
    if (cleaned === null) return bad('ruleOverride');
    ruleOverride = cleaned;
  }
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
    const reviewValue = rawReview as Obj;
    const review = isReview ? { review: {
      prNumber: reviewValue['prNumber'] as number,
      botLogin: reviewValue['botLogin'] as string,
      ...(kind === 'FIX' && reviewValue['trustDetectedChecks'] === true ? { trustDetectedChecks: true as const } : {}),
      ...(reviewRulings === undefined ? {} : { rulings: reviewRulings }),
      ...(reviewDecisions === undefined ? {} : { decisions: reviewDecisions }),
    } } : {};
    return { ok: true, assign: { ...baseAssign, ...expectBranch, ...review, ...(agent === undefined ? {} : { agent }), ...(ruleOverride === undefined ? {} : { ruleOverride }) } };
  }
  const t = p['thread'];
  if (!isObj(t)) return bad('thread');
  if (!checked(() => assertSegment('threadId', t['threadId']))) return bad('threadId');
  const action = t['action'];
  if (action !== 'SESSION' && action !== 'PUBLISH' && action !== 'DISCARD') return bad('thread action');
  const rawMode = t['mode'];
  if (rawMode !== undefined && rawMode !== 'read' && rawMode !== 'ask' && rawMode !== 'full') return bad('thread mode');
  // Fleet S5b: `kind` is optional (absent means REPO); a PROJECT or WORKSPACE thread only ever runs a SESSION.
  const rawKind = t['kind'];
  if (rawKind !== undefined && rawKind !== 'REPO' && rawKind !== 'PROJECT' && rawKind !== 'WORKSPACE') return bad('thread kind');
  if ((rawKind === 'PROJECT' || rawKind === 'WORKSPACE') && action !== 'SESSION') return bad('thread action');
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
  // Unchanged S5b 1c-b rule: only PROJECT reads project code — a REPO, WORKSPACE or kind-less block carrying
  // either list is refused whole.
  if ((rawRepos !== undefined || rawUnavailable !== undefined) && rawKind !== 'PROJECT') return bad('project repos');
  const projectRepos = rawRepos === undefined ? undefined : cleanProjectRepos(rawRepos);
  const projectReposUnavailable = rawUnavailable === undefined ? undefined : cleanProjectUnavailable(rawUnavailable);
  if (projectRepos === null || projectReposUnavailable === null) return bad('project repos');
  const thread: ThreadAssign = {
    threadId: t['threadId'] as string,
    ...(rawMode === undefined ? {} : { mode: rawMode }),
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
