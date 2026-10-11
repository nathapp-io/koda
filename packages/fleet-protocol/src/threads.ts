/** Fleet S5a §1, §3: chat thread job kind, command types and wire payloads. The API mirrors the runtime values in apps/api/src/fleet/common/thread-jobs.ts. */
export const THREAD_JOB_KIND = 'THREAD' as const;

export function isThreadKind(command: string): command is typeof THREAD_JOB_KIND {
  return command === THREAD_JOB_KIND;
}

/** `THREAD_PUBLISH` is declared for protocol stability; nothing queues it before phase C. */
export const THREAD_COMMAND_TYPES = ['THREAD_INPUT', 'THREAD_ANSWER', 'THREAD_STOP_TURN', 'THREAD_CLOSE', 'THREAD_PUBLISH'] as const;
export type ThreadCommandType = (typeof THREAD_COMMAND_TYPES)[number];

export type ThreadAgent = 'claude' | 'codex';

export type ThreadBackend =
  | { kind: 'native'; model?: string; effort?: string }
  | { kind: 'acp'; agent: ThreadAgent; model?: string; effort?: string };

/** Runner capability report: native model ids it can serve, ACP agents it can launch. */
export interface ThreadBackends { native: string[]; acp: ThreadAgent[] }

export interface ThreadSkill { name: string; dir: string; description: string }
export interface ThreadSkillSource { sourceId: string; owner: string; repo: string; sha: string; skills: ThreadSkill[] }

export type ThreadAction = 'SESSION' | 'PUBLISH';

/** ASSIGN's `thread` block, present only for THREAD jobs. */
export interface ThreadAssign {
  threadId: string;
  action: ThreadAction;
  /** The thread's feature (branch feat/<feature>), not the job's `thread-<id>` feature. */
  feature: string;
  resume: boolean;
  instructions: string;
  backend: ThreadBackend;
  skills: ThreadSkillSource[];
  initialMessage: { messageId: string; text: string } | null;
}

export interface ThreadInputPayload { messageId: string; text: string }
export interface ThreadAnswerPayload { requestId: string; text: string }

export const THREAD_LIMITS = { messageMaxBytes: 32_768, maxNativeModels: 32, maxAcpAgents: 8, maxArchivedThreadIds: 100 } as const;
