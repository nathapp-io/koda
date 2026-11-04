import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_EFFORT_RE, ACP_MODEL_ID_RE, ACP_OFFER_LIMITS, type ThreadAcpOffer, type ThreadAgent } from '@nathapp/fleet-protocol';
import { createAgentSession, createMemoryTranscriptStore, type AgentSession, type CreateAgentSessionOptions, type SessionBackend } from '@nathapp/nax-agent';
import { acpBackend, launchCandidateKind, type AcpBackendOptions, type LaunchCandidateKind } from '@nathapp/nax-agent-acp/client';
import { agentSessionCode } from '../thread/session-factory';

/**
 * thread-agents-modes US-002: what the runner advertises about the ACP agents a thread may run on. The API admits
 * these three (packages/fleet-protocol/src/threads.ts); nax-agent-acp knows more, and koda reports none of them yet.
 */
export const ACP_AGENTS: readonly ThreadAgent[] = ['claude', 'codex', 'cursor'];

/** The accepted `initialize` bound of a probe's open: the agent must answer within it or the probe gives up. */
export const ACP_INITIALIZE_TIMEOUT_MS = 20_000;
/** The probe's own deadline per agent, so one unreachable agent cannot hold the capability report. */
export const ACP_PROBE_TIMEOUT_MS = 20_000;
/** The API's `THREAD_LIMITS.maxNativeModels`, which bounds `acpOffers[].models` (apps/api/src/fleet/common). */
export const MAX_OFFERED_MODELS = 32;

/** One agent's discovery report; `loggedIn` is null when the agent was not probed or the probe failed. */
export type AcpAgentProbe = () => Promise<ThreadAcpOffer[]>;

/** The probe's clock: injected so a spec can reach the deadline without waiting for it. */
export interface AcpProbeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A throwaway directory a probe session runs in, removed when that agent's probe is done. */
export interface ProbeWorkdir {
  readonly dir: string;
  remove(): Promise<void>;
}

/**
 * Every seam the probe opens: the launch check and the backend factory are the two the spec names, the rest let a
 * spec hold an open past the deadline without a real agent process or a real clock.
 */
export interface AcpProbeDeps {
  /** Production: `launchCandidateKind(agent)` — a local binary or the npx fallback; undefined means "not installed". */
  readonly launchCandidate?: (agent: ThreadAgent) => LaunchCandidateKind | undefined;
  /** Production: nax-agent-acp's `acpBackend`. */
  readonly backend?: (options: AcpBackendOptions) => SessionBackend;
  /** Production: nax-agent's `createAgentSession`. */
  readonly openSession?: (options: CreateAgentSessionOptions) => Promise<AgentSession>;
  /** Where the probe's session runs; production makes and removes a private temp directory. */
  readonly makeWorkdir?: () => Promise<ProbeWorkdir>;
  readonly timers?: AcpProbeTimers;
}

const SYSTEM_TIMERS: AcpProbeTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

const AUTH_REQUIRED = 'AGENT_SESSION_AUTH_REQUIRED';

async function makeTempWorkdir(): Promise<ProbeWorkdir> {
  const dir = await mkdtemp(join(tmpdir(), 'koda-runner-acp-probe-'));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

const offeredIds = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);

/** Only ids the API's validator keeps reach the report, so one stale agent id cannot cost the whole `acpOffers`. */
function offeredModels(capabilities: Readonly<Record<string, unknown>>): string[] {
  return offeredIds(capabilities['offeredModels']).filter((id) => ACP_MODEL_ID_RE.test(id)).slice(0, MAX_OFFERED_MODELS);
}

function offeredEfforts(capabilities: Readonly<Record<string, unknown>>): string[] {
  return offeredIds(capabilities['offeredEfforts']).filter((id) => ACP_EFFORT_RE.test(id)).slice(0, ACP_OFFER_LIMITS.maxEfforts);
}

type Settled = { readonly kind: 'session'; readonly session: AgentSession } | { readonly kind: 'error'; readonly error: unknown };

/** A launch check that cannot answer counts as launchable: "not installed" would hide an agent that is installed. */
function isLaunchable(agent: ThreadAgent, check: (agent: ThreadAgent) => LaunchCandidateKind | undefined): boolean {
  try {
    return check(agent) !== undefined;
  } catch {
    return true;
  }
}

/** Resolves null when the deadline wins; `settled` never rejects, so its later value can still be read and closed. */
async function withinDeadline(settled: Promise<Settled>, timers: AcpProbeTimers): Promise<Settled | null> {
  let handle: unknown;
  const deadline = new Promise<null>((resolve) => {
    handle = timers.setTimeout(() => { resolve(null); }, ACP_PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    timers.clearTimeout(handle);
  }
}

/**
 * What one agent offers. A launched agent is opened tool-less and memory-only under the `ask` profile, which is the
 * cheapest session that makes an agent report its models without running a turn; the session is closed as soon as the
 * capability record is read. A probe that does not settle in time is reported unknown, and a session that arrives
 * after its deadline is still closed — the runner never leaves a probe session behind.
 */
async function probeAgent(agent: ThreadAgent, deps: AcpProbeDeps): Promise<ThreadAcpOffer> {
  const withoutOffers = (launchable: boolean, loggedIn: boolean | null): ThreadAcpOffer => ({ agent, launchable, loggedIn, models: [], efforts: [] });
  if (!isLaunchable(agent, deps.launchCandidate ?? ((a: ThreadAgent) => launchCandidateKind(a)))) return withoutOffers(false, null);

  let workdir: ProbeWorkdir | undefined;
  try {
    workdir = await (deps.makeWorkdir ?? makeTempWorkdir)();
    const backend = (deps.backend ?? acpBackend)({
      agent, allowUnsandboxed: true, initializeTimeoutMs: ACP_INITIALIZE_TIMEOUT_MS,
    });
    // `createAgentSession` requires a workdir for a profile other than `none`; the store keeps the probe's
    // transcript in memory, so nothing of it survives the probe.
    const opening = (deps.openSession ?? createAgentSession)({
      backend, profile: 'ask', workdir: workdir.dir, tools: [], transcriptStore: createMemoryTranscriptStore(),
    });
    const settled = opening.then(
      (session): Settled => ({ kind: 'session', session }),
      (error: unknown): Settled => ({ kind: 'error', error }),
    );
    const outcome = await withinDeadline(settled, deps.timers ?? SYSTEM_TIMERS);
    if (outcome === null) {
      void settled.then((late) => (late.kind === 'session' ? late.session.close().catch(() => undefined) : undefined));
      return withoutOffers(true, null);
    }
    if (outcome.kind === 'error') return withoutOffers(true, agentSessionCode(outcome.error) === AUTH_REQUIRED ? false : null);
    const { capabilities } = outcome.session.backend;
    try {
      return { agent, launchable: true, loggedIn: true, models: offeredModels(capabilities), efforts: offeredEfforts(capabilities) };
    } finally {
      await outcome.session.close().catch(() => undefined);
    }
  } catch {
    // A workdir, backend or session-construction failure is likewise unknown, never "not logged in".
    return withoutOffers(true, null);
  } finally {
    // The probe's directory goes as soon as it has its answer, even if an unresponsive open is still in flight: the
    // report cannot wait for it, and a session that settles later is closed by the timeout handler above.
    await workdir?.remove().catch(() => undefined);
  }
}

/**
 * The three ACP agents, probed in parallel: the launch check first (no process is spawned for an agent this machine
 * cannot start), then one short session per launchable agent. Never rejects — a failed agent is reported with
 * `loggedIn: null` and empty lists, and the others still come back.
 */
export async function probeAcpAgents(deps: AcpProbeDeps = {}): Promise<ThreadAcpOffer[]> {
  return await Promise.all(ACP_AGENTS.map((agent) => probeAgent(agent, deps)));
}
