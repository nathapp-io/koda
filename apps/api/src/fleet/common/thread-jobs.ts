/** Runtime mirror of packages/fleet-protocol/src/threads.ts (fleet S5a); thread-jobs.spec.ts pins them equal. */
import type { ThreadCommandType } from '@nathapp/fleet-protocol';

export type {
  ThreadAction, ThreadAgent, ThreadAnswerPayload, ThreadAssign, ThreadBackend, ThreadBackends, ThreadCommandType,
  ThreadInputPayload, ThreadSkill, ThreadSkillSource,
} from '@nathapp/fleet-protocol';

export const THREAD_JOB_KIND = 'THREAD' as const;

export function isThreadKind(command: string): command is typeof THREAD_JOB_KIND {
  return command === THREAD_JOB_KIND;
}

export const THREAD_COMMAND_TYPES: readonly ThreadCommandType[] = ['THREAD_INPUT', 'THREAD_ANSWER', 'THREAD_STOP_TURN', 'THREAD_CLOSE', 'THREAD_PUBLISH'];

export const THREAD_LIMITS = { messageMaxBytes: 32_768, maxNativeModels: 32, maxAcpAgents: 8, maxArchivedThreadIds: 100 } as const;

/** A native model id: starts alphanumeric, then letters, digits and `._:/@-`, at most 128 characters. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
