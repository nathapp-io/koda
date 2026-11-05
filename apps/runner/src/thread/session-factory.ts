import {
  AgentSessionError,
  createAgentSession,
  createFileTranscriptStore,
  nativeBackend,
  resumeAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CredentialSource,
  type NativeBackendOptions,
  type SessionBackend,
} from '@nathapp/nax-agent';
import { acpBackend, type AcpBackendOptions } from '@nathapp/nax-agent-acp/client';
import type { ThreadAssign, ThreadBackend, ThreadFailReason } from '@nathapp/fleet-protocol';
import { selfCommand as defaultSelfCommand } from '../self-command';
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
  /**
   * US-011: this runner's own argv, prepended to the `provider-cred` exec helper a native session is opened with.
   * Optional so an existing construction keeps working: it defaults to `selfCommand()`.
   */
  selfCommand?: readonly string[];
}

/**
 * US-011: what a native session needs from the runner's provider-key vault. `socket` is the job epoch's provider-key
 * socket, and `granted` answers whether koda resolves a key for a provider for this thread's scope (the broker's own
 * lookup — the same one the socket answers — so the decision and the hand-out can never disagree).
 */
export interface ThreadProviderKeys {
  readonly socket: string;
  granted(providerId: string): Promise<boolean>;
}

export interface OpenThreadSessionOptions {
  jobId: string;
  thread: ThreadAssign;
  worktree: string;
  tools: CreateAgentSessionOptions['tools'];
  approvalTimeoutSec: number;
  /**
   * US-011: the job's provider keys, when this runner serves any. Absent (a runner without a vault, or a job whose
   * socket could not be served) keeps today's backend options: nax's process-wide store — the machine's own
   * credentials — serves the session.
   */
  providerKeys?: ThreadProviderKeys;
}

export type OpenThreadSessionResult =
  | { ok: true; session: AgentSession; resumed: boolean }
  | { ok: false; reason: ThreadFailReason };

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EFFORT_RE = /^[a-z]{1,16}$/;
const MIN_APPROVAL_TIMEOUT_MS = 30_000;
const MAX_APPROVAL_TIMEOUT_MS = 3_600_000;
/** US-011, design §5.4: nax's schema maximum, so a thread's provider lookup gets the same bound a fleet job's does. */
const PROVIDER_CRED_TIMEOUT_MS = 60_000;

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
  /** US-011: the argv the exec helper runs the runner again with. */
  private readonly self: readonly string[];

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
    this.self = options.selfCommand ?? defaultSelfCommand();
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

      // US-011: the provider lookup comes after every existing validation, so an unknown model, an invalid effort
      // or an unusable thread id fails exactly as before and never waits on the vault.
      const credentials = await this.credentialSource(model, input.providerKeys);
      const backendOptions = {
        ...(thread.mode === 'ask' || thread.mode === 'full' ? { allowUnsandboxed: true } : {}),
        // thread-agents-modes (branch fix B2): nax-agent resolves `bashApproval` to `gated` whatever the profile, so
        // `full` — the no-prompts mode — has to ask for `raw` explicitly or every Bash call would wait for a decision.
        // `ask` keeps gated, which its profile requires (a non-gated mode would run Bash without asking).
        ...(thread.mode === 'full' ? { bashApproval: 'raw' as const } : {}),
        model: effort === undefined ? model : `${model}[${effort}]`,
        carryHistoryAcrossModels: true,
        hostPorts: {
          protectedPaths: {
            gitExcludePathspecs: [],
            gitIgnorePatterns: [],
            credentialDir: this.options.naxHome,
          },
        },
        ...(credentials === undefined ? {} : { credentials }),
      } satisfies NativeBackendOptions;
      return await this.start(input, this.agent.nativeBackend(backendOptions));
    } catch (error) {
      return { ok: false, reason: failureReason(error) };
    }
  }

  /**
   * US-011, design §5.5: the per-session credential source for a native session. The provider is the validated model
   * id's text before the first `/` — the same prefix nax's own model ids carry — and a model id with no prefix names no
   * provider, so it gets no koda key. A grant makes the session read its keys from the job's socket through the
   * `provider-cred` exec helper; without one the session opens without `credentials` and nax's process-wide store (the
   * machine's own) serves it, which is exactly how a runner with no vault behaves.
   *
   * A lookup that throws is treated as no grant: a thread must still open on the machine's own credentials rather than
   * fail because the vault hiccuped. A model switch inside one open session is deliberately not re-resolved — the
   * per-session source has no file fallback, so the next session open resolves it again.
   */
  private async credentialSource(model: string, providerKeys: ThreadProviderKeys | undefined): Promise<CredentialSource | undefined> {
    if (providerKeys === undefined) return undefined;
    const separator = model.indexOf('/');
    if (separator <= 0) return undefined;
    let granted = false;
    try {
      granted = await providerKeys.granted(model.slice(0, separator));
    } catch {
      return undefined;
    }
    if (!granted) return undefined;
    return {
      kind: 'exec',
      command: [...this.self, 'provider-cred', '--socket', providerKeys.socket],
      timeoutMs: PROVIDER_CRED_TIMEOUT_MS,
    };
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
