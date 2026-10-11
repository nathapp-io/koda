import {
  AgentSessionError,
  createAgentSession,
  createFileTranscriptStore,
  nativeBackend,
  resumeAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
  type NativeBackendOptions,
} from '@nathapp/nax-agent';
import type { ThreadAssign, ThreadFailReason } from '@nathapp/fleet-protocol';
import { threadTranscriptDir } from './thread-paths';
import type { NativeModelSet } from './native-models';

interface AgentSessionFactory {
  createAgentSession: typeof createAgentSession;
  resumeAgentSession: typeof resumeAgentSession;
  nativeBackend: typeof nativeBackend;
  createFileTranscriptStore: typeof createFileTranscriptStore;
}

interface ThreadSessionFactoryOptions {
  homeDir: string;
  naxHome: string;
  nativeModels: () => Promise<NativeModelSet>;
  agent?: AgentSessionFactory;
}

interface OpenThreadSessionOptions {
  jobId: string;
  thread: ThreadAssign;
  worktree: string;
  tools: CreateAgentSessionOptions['tools'];
  approvalTimeoutSec: number;
}

export type OpenThreadSessionResult =
  | { ok: true; session: AgentSession; resumed: boolean }
  | { ok: false; reason: ThreadFailReason };

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EFFORT_RE = /^[a-z]{1,16}$/;
const MIN_APPROVAL_TIMEOUT_MS = 30_000;
const MAX_APPROVAL_TIMEOUT_MS = 3_600_000;

/**
 * The agent-session error code behind `error`, whatever prototype it carries. `instanceof` alone
 * misses an `AgentSessionError` built from a second copy of nax-agent (a compiled bundle or a
 * duplicated install), so the code — the contract — is read structurally as well.
 */
function agentSessionCode(error: unknown): string | undefined {
  if (error instanceof AgentSessionError) return error.code;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function failureReason(error: unknown): ThreadFailReason {
  const code = agentSessionCode(error);
  if (code === 'AGENT_SESSION_AUTH_REQUIRED') return 'agent_not_logged_in';
  if (code === 'AGENT_SESSION_BACKEND_UNAVAILABLE') return 'backend_unavailable';
  return 'session_error';
}

/** nax-agent takes an integer in [30000, 3600000]; a non-finite request falls back to the floor. */
function approvalTimeoutMsFor(approvalTimeoutSec: number): number {
  const requested = Math.round(approvalTimeoutSec * 1000);
  if (!Number.isFinite(requested)) return MIN_APPROVAL_TIMEOUT_MS;
  return Math.min(MAX_APPROVAL_TIMEOUT_MS, Math.max(MIN_APPROVAL_TIMEOUT_MS, requested));
}

export class ThreadSessionFactory {
  private readonly agent: AgentSessionFactory;

  constructor(private readonly options: ThreadSessionFactoryOptions) {
    this.agent = options.agent ?? {
      createAgentSession,
      resumeAgentSession,
      nativeBackend,
      createFileTranscriptStore,
    };
  }

  async open(input: OpenThreadSessionOptions): Promise<OpenThreadSessionResult> {
    // The whole body is guarded: `thread` and `backend` arrive over the wire, so a malformed assign
    // and a rejecting `nativeModels()` must resolve to a failure reason, not escape as a rejection.
    try {
      const { thread } = input;
      if (thread.backend.kind === 'acp') return { ok: false, reason: 'backend_unavailable' };

      const models = await this.options.nativeModels();
      const model = thread.backend.model ?? models.defaultModel;
      if (model === null || model === undefined || !models.models.includes(model)) {
        return { ok: false, reason: 'model_unknown' };
      }
      const effort: unknown = thread.backend.effort;
      if (effort !== undefined && (typeof effort !== 'string' || !EFFORT_RE.test(effort))) {
        return { ok: false, reason: 'model_unknown' };
      }
      if (!SESSION_ID_RE.test(thread.threadId)) return { ok: false, reason: 'session_error' };

      const backendOptions = {
        model: effort === undefined ? model : `${model}[${effort}]`,
        carryHistoryAcrossModels: true,
        hostPorts: {
          protectedPaths: {
            gitExcludePathspecs: [],
            gitIgnorePatterns: [],
            credentialDir: this.options.naxHome,
          },
        },
      } satisfies NativeBackendOptions;
      const backend = this.agent.nativeBackend(backendOptions);
      const sessionOptions: CreateAgentSessionOptions = {
        backend,
        profile: 'read',
        workdir: input.worktree,
        instructions: thread.instructions,
        tools: input.tools,
        transcriptStore: this.agent.createFileTranscriptStore(threadTranscriptDir(this.options.homeDir, thread.threadId)),
        approvalTimeoutMs: approvalTimeoutMsFor(input.approvalTimeoutSec),
        turnTimeoutSeconds: 900,
        metadata: { threadId: thread.threadId, jobId: input.jobId },
      };

      if (thread.resume) {
        try {
          const session = await this.agent.resumeAgentSession(thread.threadId, sessionOptions);
          return { ok: true, session, resumed: true };
        } catch (error) {
          if (agentSessionCode(error) !== 'AGENT_SESSION_NOT_FOUND') throw error;
          const session = await this.agent.createAgentSession({ ...sessionOptions, sessionId: thread.threadId });
          return { ok: true, session, resumed: false };
        }
      }

      try {
        const session = await this.agent.createAgentSession({ ...sessionOptions, sessionId: thread.threadId });
        return { ok: true, session, resumed: false };
      } catch (error) {
        if (agentSessionCode(error) !== 'AGENT_SESSION_EXISTS') throw error;
        const session = await this.agent.resumeAgentSession(thread.threadId, sessionOptions);
        return { ok: true, session, resumed: true };
      }
    } catch (error) {
      return { ok: false, reason: failureReason(error) };
    }
  }
}
