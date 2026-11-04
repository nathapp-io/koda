import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { AgentSessionError, type OpenedBackend, type SessionBackend } from '@nathapp/nax-agent';
import type { AcpBackendOptions, LaunchCandidateKind } from '@nathapp/nax-agent-acp/client';
import type { ThreadAcpOffer, ThreadAgent } from '@nathapp/fleet-protocol';
import { waitFor } from '../../test/helpers/wait';
import { ACP_AGENTS, probeAcpAgents, type AcpProbeDeps, type AcpProbeTimers } from './acp-agent-probe';

/** The probe's workdir only has to exist: every backend in this file is injected and writes nothing. */
const WORKDIR = tmpdir();

/** A frozen stand-in for nax-agent's opened session; `close` is how the probe releases it. */
function openedBackend(input: { capabilities?: Record<string, unknown>; onClose: () => void }): OpenedBackend {
  const handle = { id: 'probe-session', agentName: 'claude' };
  return {
    info: { kind: 'acp:probe', capabilities: input.capabilities ?? {} },
    adapter: {
      openSession: async () => handle,
      sendTurn: async () => {
        throw new Error('the probe never sends a turn');
      },
      closeSession: async () => undefined,
    },
    handle,
    turnOpts: () => ({ interactionHandler: { onInteraction: async () => null } }),
    close: async () => {
      input.onClose();
    },
  };
}

function nameOf(options: AcpBackendOptions): ThreadAgent {
  const name = typeof options.agent === 'string' ? options.agent : options.agent.name;
  if (name !== 'claude' && name !== 'codex' && name !== 'cursor') throw new Error(`unexpected agent ${name}`);
  return name;
}

interface HarnessInput {
  /** The agents the injected launch check finds a candidate for; the rest answer "no candidate". */
  readonly launchable?: readonly ThreadAgent[];
  /** What an opened session reports as `backend.capabilities`. */
  readonly capabilities?: (agent: ThreadAgent) => Record<string, unknown>;
  /** Overrides the open itself (a refusal, a hang); `opened` builds a close-recording session. */
  readonly open?: (agent: ThreadAgent, opened: (agent: ThreadAgent) => OpenedBackend) => Promise<OpenedBackend>;
  readonly timers?: AcpProbeTimers;
}

function harness(input: HarnessInput = {}) {
  const calls = { launch: [] as ThreadAgent[], backend: [] as AcpBackendOptions[], open: [] as ThreadAgent[], closed: [] as ThreadAgent[], workdirsRemoved: 0 };
  const openedFor = (agent: ThreadAgent): OpenedBackend =>
    openedBackend({ capabilities: input.capabilities?.(agent) ?? {}, onClose: () => calls.closed.push(agent) });
  const deps: AcpProbeDeps = {
    launchCandidate: (agent): LaunchCandidateKind | undefined => {
      calls.launch.push(agent);
      return (input.launchable ?? ACP_AGENTS).includes(agent) ? 'local' : undefined;
    },
    backend: (options): SessionBackend => {
      calls.backend.push(options);
      const name = nameOf(options);
      return {
        kind: `acp:${name}`,
        open: async () => {
          calls.open.push(name);
          return await (input.open?.(name, openedFor) ?? Promise.resolve(openedFor(name)));
        },
      };
    },
    makeWorkdir: async () => ({
      dir: WORKDIR,
      remove: async () => {
        calls.workdirsRemoved += 1;
      },
    }),
    ...(input.timers === undefined ? {} : { timers: input.timers }),
  };
  return { deps, calls, openedFor };
}

/** A 20 s deadline the test fires by hand, so no spec waits. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 0;
  const timers: AcpProbeTimers = {
    setTimeout: (callback, ms) => {
      delays.push(ms);
      pending.set(next, callback);
      return next++;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') pending.delete(handle);
    },
  };
  return { timers, delays, fire: () => { for (const [handle, callback] of [...pending]) { pending.delete(handle); callback(); } }, get waiting() { return pending.size; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const offerFor = (offers: readonly ThreadAcpOffer[], agent: ThreadAgent): ThreadAcpOffer | undefined => offers.find((offer) => offer.agent === agent);
const never = (): Promise<OpenedBackend> => new Promise<OpenedBackend>(() => undefined);

describe('probeAcpAgents: launch check (US-002 AC-1)', () => {
  test('AC-1: an agent the launch check cannot start is not launchable and opens no session', async () => {
    const h = harness({ launchable: ['claude', 'cursor'] });
    const offers = await probeAcpAgents(h.deps);
    expect(offerFor(offers, 'codex')).toEqual({ agent: 'codex', launchable: false, loggedIn: null, models: [], efforts: [] });
    expect(h.calls.open).not.toContain('codex');
    expect(h.calls.backend.map(nameOf)).toEqual(['claude', 'cursor']);
  });

  test('every known ACP agent is probed, in report order', async () => {
    const h = harness();
    const offers = await probeAcpAgents(h.deps);
    expect(offers.map((offer) => offer.agent)).toEqual(['claude', 'codex', 'cursor']);
    expect(h.calls.launch).toEqual(['claude', 'codex', 'cursor']);
  });

  test('an npx-only candidate is launchable too', async () => {
    const h = harness({ launchable: ['claude'] });
    const deps: AcpProbeDeps = { ...h.deps, launchCandidate: (agent) => (agent === 'claude' ? 'npx' : undefined) };
    expect(offerFor(await probeAcpAgents(deps), 'claude')).toMatchObject({ launchable: true, loggedIn: true });
  });
});

describe('probeAcpAgents: what a launched agent offers (US-002 AC-2, AC-3, AC-4)', () => {
  test('AC-2: a launchable claude reports its offered models and efforts and the session is closed', async () => {
    const h = harness({ launchable: ['claude'], capabilities: () => ({ offeredModels: ['claude-sonnet-4-5'], offeredEfforts: ['high'] }) });
    const offers = await probeAcpAgents(h.deps);
    expect(offerFor(offers, 'claude')).toEqual({ agent: 'claude', launchable: true, loggedIn: true, models: ['claude-sonnet-4-5'], efforts: ['high'] });
    expect(h.calls.closed).toEqual(['claude']);
  });

  test('AC-3: an offered model that fails ACP_MODEL_ID_RE is dropped and the valid ones are kept', async () => {
    const tooLong = `m${'x'.repeat(200)}`;
    const h = harness({
      launchable: ['claude'],
      capabilities: () => ({ offeredModels: ['claude-sonnet-4-5', 'bad model!', tooLong, 'gpt-5.5[context=272k,reasoning=medium]'] }),
    });
    expect(offerFor(await probeAcpAgents(h.deps), 'claude')?.models).toEqual(['claude-sonnet-4-5', 'gpt-5.5[context=272k,reasoning=medium]']);
  });

  test('AC-4: at most 32 models and 8 efforts are kept per agent', async () => {
    const models = Array.from({ length: 40 }, (_, i) => `model-${i}`);
    const efforts = Array.from({ length: 12 }, (_, i) => `effort${i}`);
    const h = harness({ launchable: ['claude'], capabilities: () => ({ offeredModels: models, offeredEfforts: efforts }) });
    const claude = offerFor(await probeAcpAgents(h.deps), 'claude');
    expect(claude?.models).toEqual(models.slice(0, 32));
    expect(claude?.efforts).toEqual(efforts.slice(0, 8));
  });

  test('an offered id that is not a string, or a capabilities record without offers, yields empty lists', async () => {
    const h = harness({ launchable: ['claude', 'codex'], capabilities: (agent) => (agent === 'claude' ? { offeredModels: ['ok', 7, null], offeredEfforts: 'high' } : {}) });
    const offers = await probeAcpAgents(h.deps);
    expect(offerFor(offers, 'claude')).toMatchObject({ loggedIn: true, models: ['ok'], efforts: [] });
    expect(offerFor(offers, 'codex')).toMatchObject({ loggedIn: true, models: [], efforts: [] });
  });
});

describe('probeAcpAgents: failures (US-002 AC-5, AC-6, AC-7, AC-15)', () => {
  test('AC-5: AGENT_SESSION_AUTH_REQUIRED from the open is loggedIn false with empty lists', async () => {
    const h = harness({
      launchable: ['cursor'],
      open: async () => {
        throw new AgentSessionError('cursor needs a login', 'AGENT_SESSION_AUTH_REQUIRED');
      },
    });
    const offers = await probeAcpAgents(h.deps);
    expect(offerFor(offers, 'cursor')).toEqual({ agent: 'cursor', launchable: true, loggedIn: false, models: [], efforts: [] });
    expect(h.calls.closed).toEqual([]);
  });

  test('AC-15: a non-authentication probe failure is loggedIn null, and the other agents are still reported', async () => {
    const h = harness({
      launchable: ['claude', 'codex'],
      capabilities: () => ({ offeredModels: ['gpt-5.5'], offeredEfforts: ['low'] }),
      open: async (agent, opened) => {
        if (agent === 'claude') throw new Error('the agent process died during initialize');
        return opened(agent);
      },
    });
    const offers = await probeAcpAgents(h.deps);
    expect(offerFor(offers, 'claude')).toEqual({ agent: 'claude', launchable: true, loggedIn: null, models: [], efforts: [] });
    expect(offerFor(offers, 'codex')).toEqual({ agent: 'codex', launchable: true, loggedIn: true, models: ['gpt-5.5'], efforts: ['low'] });
  });

  test('AC-6: an open that does not settle within 20 s is loggedIn null and the other agents still come back', async () => {
    const clock = fakeTimers();
    const started = deferred<void>();
    const h = harness({
      launchable: ['claude', 'codex'],
      timers: clock.timers,
      capabilities: () => ({ offeredModels: ['gpt-5.5'], offeredEfforts: ['low'] }),
      open: async (agent, opened) => {
        if (agent !== 'claude') return opened(agent);
        started.resolve();
        return await never();
      },
    });
    const running = probeAcpAgents(h.deps);
    await started.promise;
    // Both agents registered their deadline; codex's session settled, so only its probe's timer is cleared.
    await waitFor(() => clock.delays.length === 2 && clock.waiting === 1);
    expect(clock.delays.every((ms) => ms === 20_000)).toBe(true);
    clock.fire();
    const offers = await running;
    expect(offerFor(offers, 'claude')).toEqual({ agent: 'claude', launchable: true, loggedIn: null, models: [], efforts: [] });
    expect(offerFor(offers, 'codex')).toMatchObject({ launchable: true, loggedIn: true, models: ['gpt-5.5'] });
    expect(clock.waiting).toBe(0);
  });

  test('AC-7: a session that opens after its timeout is closed when it settles', async () => {
    const clock = fakeTimers();
    const late = deferred<OpenedBackend>();
    const h = harness({ launchable: ['claude'], timers: clock.timers, open: async () => await late.promise });
    const running = probeAcpAgents(h.deps);
    await waitFor(() => clock.waiting === 1);
    clock.fire();
    expect(offerFor(await running, 'claude')).toEqual({ agent: 'claude', launchable: true, loggedIn: null, models: [], efforts: [] });
    expect(h.calls.closed).toEqual([]);
    late.resolve(h.openedFor('claude'));
    await waitFor(() => h.calls.closed.length === 1);
    expect(h.calls.closed).toEqual(['claude']);
  });

  test('a launch check that throws is a failed probe, not a false "not installed"', async () => {
    const h = harness();
    const deps: AcpProbeDeps = {
      ...h.deps,
      launchCandidate: (agent) => {
        if (agent === 'codex') throw new Error('PATH unreadable');
        return 'local';
      },
    };
    expect(offerFor(await probeAcpAgents(deps), 'codex')).toMatchObject({ launchable: true });
    expect(h.calls.open).toContain('codex');
  });
});

describe('probeAcpAgents: the open it builds (US-002 AC-8, AC-9)', () => {
  test('AC-8: the backend factory gets initializeTimeoutMs 20000, unsandboxed and the agent it probes', async () => {
    const h = harness({ launchable: ['claude', 'codex'] });
    await probeAcpAgents(h.deps);
    expect(h.calls.backend).toEqual([
      { agent: 'claude', allowUnsandboxed: true, initializeTimeoutMs: 20_000 },
      { agent: 'codex', allowUnsandboxed: true, initializeTimeoutMs: 20_000 },
    ]);
  });

  test('AC-9: the opens of two launchable agents start before either resolves', async () => {
    const gates = new Map<ThreadAgent, ReturnType<typeof deferred<OpenedBackend>>>([
      ['claude', deferred<OpenedBackend>()],
      ['codex', deferred<OpenedBackend>()],
    ]);
    const started = deferred<void>();
    const seen: ThreadAgent[] = [];
    const h = harness({
      launchable: ['claude', 'codex'],
      open: async (agent) => {
        seen.push(agent);
        if (seen.length === 2) started.resolve();
        const gate = gates.get(agent);
        if (gate === undefined) throw new Error(`no gate for ${agent}`);
        return await gate.promise;
      },
    });
    const running = probeAcpAgents(h.deps);
    await started.promise;
    expect([...seen].sort()).toEqual(['claude', 'codex']);
    expect(h.calls.closed).toEqual([]);
    for (const [agent, gate] of gates) gate.resolve(h.openedFor(agent));
    const offers = await running;
    expect(offers.filter((offer) => offer.launchable).map((offer) => offer.loggedIn)).toEqual([true, true]);
    expect([...h.calls.closed].sort()).toEqual(['claude', 'codex']);
  });

  test('the probe removes its throwaway workdir once an agent is done, and never creates one for an unlaunchable agent', async () => {
    const h = harness({ launchable: ['claude'] });
    await probeAcpAgents(h.deps);
    expect(h.calls.workdirsRemoved).toBe(1);
  });
});
