import {
  AgentSessionError,
  createAgentSession,
  createFileTranscriptStore,
  nativeBackend,
  resumeAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
  type NativeBackendOptions,
  type SessionBackend,
} from '@nathapp/nax-agent';
import { acpBackend, type AcpBackendOptions } from '@nathapp/nax-agent-acp/client';
import type { ThreadAssign, ThreadBackend, ThreadFailReason } from '@nathapp/fleet-protocol';
import { threadTranscriptDir } from './thread-paths';
import type { NativeModelSet } from './native-models';

type AcpThreadBackend = Extract<ThreadBackend, { kind: 'acp' }>;

interface AgentSessionFactory {
  createAgentSession: typeof createAgentSession;
  resumeAgentSession: typeof resumeAgentSession;
  nativeBackend: typeof nativeBackend;
  /** thread-agents-modes US-003: the ACP backend factory. Absent in a spec: production's factory is used. */
  acpBackend?: typeof acpBackend;
  createFileTranscriptStore: typeof createFileTranscriptStore;
}

interface ThreadSessionFactoryOptions {
  homeDir: string;
  naxHome: string;
  nativeModels: () => Promise<NativeModelSet>;
  agent?: AgentSessionFactory;
}

export interface OpenThreadSessionOptions {
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
export function agentSessionCode(error: unknown): string | undefined {
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

/**
 * thread-agents-modes US-003: the ACP backend's own options, exactly as `nax chat` opens an agent — unsandboxed on the
 * runner host, with the runner's environment — plus the thread's model and effort when it pinned them.
 */
function acpBackendOptions(backend: AcpThreadBackend): AcpBackendOptions {
  return {
    agent: backend.agent,
    allowUnsandboxed: true,
    inheritEnv: true,
    ...(backend.model === undefined ? {} : { model: backend.model }),
    ...(backend.effort === undefined ? {} : { effort: backend.effort }),
  };
}

export class ThreadSessionFactory {
  private readonly agent: AgentSessionFactory;
  private readonly acp: typeof acpBackend;

  constructor(private readonly options: ThreadSessionFactoryOptions) {
    this.agent = options.agent ?? {
      createAgentSession,
      resumeAgentSession,
      nativeBackend,
      createFileTranscriptStore,
    };
    // The ACP factory is the one dependency from another package (nax-agent-acp), so a spec that injects the
    // nax-agent functions alone still opens an `acp` thread through production's factory.
    this.acp = this.agent.acpBackend ?? acpBackend;
  }

  async open(input: OpenThreadSessionOptions): Promise<OpenThreadSessionResult> {
    // The whole body is guarded: `thread` and `backend` arrive over the wire, so a malformed assign
    // and a rejecting `nativeModels()` must resolve to a failure reason, not escape as a rejection.
    try {
      const { thread } = input;
      // thread-agents-modes US-003: an ACP thread opens through the ACP factory. Its model is the agent's, not a
      // native id, so `nativeModels()` has nothing to say about it and is never consulted.
      if (thread.backend.kind === 'acp') {
        if (!SESSION_ID_RE.test(thread.threadId)) return { ok: false, reason: 'session_error' };
        return await this.start(input, this.acp(acpBackendOptions(thread.backend)));
      }

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
        ...(thread.mode === 'ask' || thread.mode === 'full' ? { allowUnsandboxed: true } : {}),
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
      return await this.start(input, this.agent.nativeBackend(backendOptions));
    } catch (error) {
      return { ok: false, reason: failureReason(error) };
    }
  }

  /**
   * The session itself, on a backend the caller built: one set of options for native and ACP alike, then the
   * resume/create fallback. Errors escape to `open`, which maps the agent-session codes to a failure reason.
   */
  private async start(input: OpenThreadSessionOptions, backend: SessionBackend): Promise<OpenThreadSessionResult> {
    const { thread } = input;
    const sessionOptions: CreateAgentSessionOptions = {
      backend,
      profile: thread.mode ?? 'read',
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
  }
}
