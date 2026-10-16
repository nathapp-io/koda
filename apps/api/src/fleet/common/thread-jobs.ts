/** Runtime mirror of packages/fleet-protocol/src/threads.ts (fleet S5a); thread-jobs.spec.ts pins them equal. */
import type { ChatThreadKind, ThreadCommandType } from '@nathapp/fleet-protocol';

export type {
  ChatThreadKind, ProjectRepoAssign, ProjectRepoUnavailable,
  ThreadAction, ThreadAgent, ThreadAnswerPayload, ThreadAssign, ThreadBackend, ThreadBackends, ThreadCommandType,
  ThreadInputPayload, ThreadSkill, ThreadSkillSource,
} from '@nathapp/fleet-protocol';

export const THREAD_JOB_KIND = 'THREAD' as const;

/** Mirror of the package's CHAT_THREAD_KINDS (fleet S5b); thread-jobs.spec.ts pins them equal. */
export const CHAT_THREAD_KINDS: readonly ChatThreadKind[] = ['REPO', 'PROJECT'];

export const THREAD_STREAM = 'thread' as const;
export const THREAD_STREAM_LIMITS = { lineMaxBytes: 65_536, streamMaxBytes: 209_715_200 } as const;

export function isThreadKind(command: string): command is typeof THREAD_JOB_KIND {
  return command === THREAD_JOB_KIND;
}

export const THREAD_COMMAND_TYPES: readonly ThreadCommandType[] = ['THREAD_INPUT', 'THREAD_ANSWER', 'THREAD_STOP_TURN', 'THREAD_CLOSE', 'THREAD_PUBLISH'];

export const THREAD_LIMITS = { messageMaxBytes: 32_768, maxNativeModels: 32, maxAcpAgents: 8, maxArchivedThreadIds: 100 } as const;

/** Mirror of the package's PROJECT_CODE_LIMITS (fleet S5b); thread-jobs.spec.ts pins them equal. */
export const PROJECT_CODE_LIMITS = { maxRepos: 10, maxUnavailable: 50 } as const;

/** A native model id: starts alphanumeric, then letters, digits and `._:/@-`, at most 128 characters. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
