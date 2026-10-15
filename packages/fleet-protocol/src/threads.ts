/** Fleet S5a §1, §3: chat thread job kind, command types and wire payloads. The API mirrors the runtime values in apps/api/src/fleet/common/thread-jobs.ts. */
export const THREAD_JOB_KIND = 'THREAD' as const;

export function isThreadKind(command: string): command is typeof THREAD_JOB_KIND {
  return command === THREAD_JOB_KIND;
}

/** `THREAD_PUBLISH` is declared for protocol stability; nothing queues it before phase C. */
export const THREAD_COMMAND_TYPES = ['THREAD_INPUT', 'THREAD_ANSWER', 'THREAD_STOP_TURN', 'THREAD_CLOSE', 'THREAD_PUBLISH'] as const;
export type ThreadCommandType = (typeof THREAD_COMMAND_TYPES)[number];

export type ThreadAgent = 'claude' | 'codex';

/** Fleet S5b §2: a thread belongs to a repo checkout (`REPO`) or to the project with no checkout (`PROJECT`). */
export type ChatThreadKind = 'REPO' | 'PROJECT';
export const CHAT_THREAD_KINDS = ['REPO', 'PROJECT'] as const;

export type ThreadBackend =
  | { kind: 'native'; model?: string; effort?: string }
  | { kind: 'acp'; agent: ThreadAgent; model?: string; effort?: string };

/** Runner capability report: native model ids it can serve, ACP agents it can launch. */
export interface ThreadBackends { native: string[]; acp: ThreadAgent[] }

/** Fleet S5b §1: one koda API tool the API attaches to a THREAD ASSIGN so the runner can proxy it into the session. */
export interface KodaToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Fleet S5b §1: what the runner's assign parser and the API's descriptor catalog both enforce. */
export const KODA_TOOL_LIMITS = { maxTools: 32, nameRe: /^koda_[a-z][a-z_]{0,58}$/ } as const;

/**
 * Fleet S5b 1c-b §1: the caps a PROJECT session's repository list respects. `maxRepos` repositories are
 * fetchable per session; `maxUnavailable` unavailable entries are kept. The API mirrors these values in
 * apps/api/src/fleet/common/thread-jobs.ts and a spec pins the two equal (the production image does not
 * ship workspace packages).
 */
export const PROJECT_CODE_LIMITS = { maxRepos: 10, maxUnavailable: 50 } as const;

/** One repository of a PROJECT session's code context: what to clone and where from. */
export interface ProjectRepoAssign {
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl: string;
}

/** A project repository the session cannot read, with the reason the agent is told. */
export interface ProjectRepoUnavailable {
  owner: string;
  name: string;
  reason: 'not a GitHub repository' | 'no installation' | 'limit';
}

export interface ThreadSkill { name: string; dir: string; description: string }
export interface ThreadSkillSource { sourceId: string; owner: string; repo: string; sha: string; skills: ThreadSkill[] }

export type ThreadAction = 'SESSION' | 'PUBLISH' | 'DISCARD';
export type ThreadPublishFailReason = 'branch_moved' | 'repo_busy' | 'no_worktree' | 'git_error';
export type ThreadDiscardFailReason = 'no_worktree' | 'git_error';

/** ASSIGN's `thread` block, present only for THREAD jobs. */
export interface ThreadAssign {
  threadId: string;
  action: ThreadAction;
  /** Fleet S5b 1a-R1: `REPO` or `PROJECT`; absent means `REPO` (older API). */
  kind?: ChatThreadKind;
  /** The thread's feature (branch feat/<feature>), not the job's `thread-<id>` feature. */
  feature: string;
  resume: boolean;
  instructions: string;
  backend: ThreadBackend;
  skills: ThreadSkillSource[];
  initialMessage: { messageId: string; text: string } | null;
  /** At most 200 characters; absent when the thread has no title. */
  title?: string;
  /** Fleet S5b §1: the koda tools the session exposes; present only for a SESSION on a runner advertising `kodaTools`. */
  kodaTools?: KodaToolDescriptor[];
  /**
   * Fleet S5b 1c-b: the project's repositories a PROJECT SESSION reads, when the runner advertises
   * `projectCode`. At most PROJECT_CODE_LIMITS.maxRepos entries; absent when the runner lacks the capability.
   */
  projectRepos?: ProjectRepoAssign[];
  /** Fleet S5b 1c-b: project repositories this session cannot read; at most PROJECT_CODE_LIMITS.maxUnavailable. */
  projectReposUnavailable?: ProjectRepoUnavailable[];
}

export interface ThreadInputPayload { messageId: string; text: string }
export interface ThreadAnswerPayload { requestId: string; text: string }

export const THREAD_LIMITS = { messageMaxBytes: 32_768, maxNativeModels: 32, maxAcpAgents: 8, maxArchivedThreadIds: 100 } as const;

/** The log stream a THREAD job writes (PUT /fleet/runner/jobs/:jobId/logs/thread). */
export const THREAD_STREAM = 'thread' as const;
export const THREAD_STREAM_LIMITS = { lineMaxBytes: 65_536, streamMaxBytes: 209_715_200 } as const;
/** Field-level limits enforced by the API parser for a `published` thread line. */
export const THREAD_PUBLICATION_LIMITS = { maxPaths: 200, maxPathChars: 512 } as const;
/** Same rule as the API's MODEL_ID_RE (apps/api/src/fleet/common/thread-jobs.ts). */
export const THREAD_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,127}$/;

export type ThreadCloseReason = 'idle' | 'closed' | 'cost_cap' | 'stream_cap' | 'cancelled';
export type ThreadFailReason = 'backend_unavailable' | 'agent_not_logged_in' | 'model_unknown' | 'skill_fetch_failed' | 'worktree_conflict' | 'session_error';

/** Lines the runner writes itself; other stream lines are nax-agent SessionEvents. */
export type ThreadRunnerLine =
  | { type: 'session_started'; at: string; resumed: boolean; backend: ThreadBackend; skillShas: string[]; stale?: true }
  | { type: 'session_closed'; at: string; reason: ThreadCloseReason }
  | { type: 'input_consumed'; at: string; messageId: string }
  | { type: 'session_failed'; at: string; reason: ThreadFailReason }
  | { type: 'write_doc'; at: string; path: string; bytes: number }
  | { type: 'published'; at: string; sha: string; paths: string[]; ignored: string[]; specPresent: boolean }
  | { type: 'publish_failed'; at: string; reason: ThreadPublishFailReason }
  | { type: 'discarded'; at: string; tipSha: string }
  | { type: 'discard_failed'; at: string; reason: ThreadDiscardFailReason };
