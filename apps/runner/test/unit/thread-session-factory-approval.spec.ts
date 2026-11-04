import { expect, test } from 'bun:test';
import type { AgentSession, CreateAgentSessionOptions, NativeBackendOptions, SessionBackend } from '@nathapp/nax-agent';
import { createFileTranscriptStore } from '@nathapp/nax-agent';
import { ThreadSessionFactory } from '../../src/thread/session-factory';
import type { ThreadAssign } from '@nathapp/fleet-protocol';

/**
 * Branch fix B2: the EFFECTIVE approval rules a native thread session opens with, resolved by the pinned
 * `@nathapp/nax-agent` (0.91.7) itself.
 *
 * `full` is the no-prompts mode, but the package resolves `bashApproval` to `gated` whatever the profile, and `gated`
 * turns every Bash command into an ask (`session-tool-support.ts` `askRulesFor`). Asserting the forwarded options only
 * proves the runner passed something; this spec feeds those options to the package's own resolution and asserts which
 * asks the session ends up with. Neither function is on the public entry, so they are loaded from the installed dist by
 * path: the pin is what makes that honest, and a package bump that moves them fails this file loudly.
 */
const distModule = async (relative: string): Promise<Record<string, unknown>> =>
  await import(new URL(relative, import.meta.url).href) as Record<string, unknown>;

const profileRules = await distModule('../../node_modules/@nathapp/nax-agent/dist/session/native-backend-options.js') as {
  nativeProfileRules: (profile: string, options: NativeBackendOptions) => {
    bashApproval: 'raw' | 'gated' | 'escalate';
    allowUnsandboxed: boolean;
    allowUnsandboxedCommands: boolean;
  };
};
const toolSupport = await distModule('../../node_modules/@nathapp/nax-agent/dist/session/session-tool-support.js') as {
  declaredToolsFor: (profile: string, protectedPaths: { gitExcludePathspecs: string[]; gitIgnorePatterns: string[] }) => readonly string[];
  askRulesFor: (declared: readonly string[], bashApproval: string, profile: string) => ReadonlyArray<{ tool: string; patterns: string[] }>;
};

/** The protected-paths policy the factory passes (credentialDir only): no git pathspec or ignore pattern. */
const PROTECTED_PATHS = { gitExcludePathspecs: [], gitIgnorePatterns: [] };

/** What the package makes of one profile's backend options: the resolved mode and the asks it raises. */
function resolved(profile: 'read' | 'ask' | 'full', options: NativeBackendOptions) {
  const rules = profileRules.nativeProfileRules(profile, options);
  const declared = toolSupport.declaredToolsFor(profile, PROTECTED_PATHS);
  return { rules, declared, asks: toolSupport.askRulesFor(declared, rules.bashApproval, profile) };
}

const session: AgentSession = {
  id: 'thread-1',
  backend: { kind: 'native', capabilities: {} },
  lastTurn: undefined,
  async *send() {},
  answer: () => 'unknown',
  cancel: () => undefined,
  close: async () => undefined,
};

function thread(overrides: Partial<ThreadAssign> = {}): ThreadAssign {
  return {
    threadId: 'thread-1',
    action: 'SESSION',
    feature: 'feature',
    resume: false,
    instructions: 'instructions',
    backend: { kind: 'native', model: 'm/x' },
    skills: [],
    initialMessage: null,
    ...overrides,
  };
}

/** Opens one native session through the real factory and returns the backend options it handed to `nativeBackend`. */
async function openNative(mode: 'read' | 'ask' | 'full' | undefined): Promise<NativeBackendOptions> {
  const native: NativeBackendOptions[] = [];
  const sentinel: SessionBackend = { kind: 'native', open: async () => { throw new Error('this spec never opens the backend'); } };
  const factory = new ThreadSessionFactory({
    homeDir: '/runner-home',
    naxHome: '/nax-home',
    nativeModels: async () => ({ models: ['m/x'], defaultModel: 'm/x' }),
    agent: {
      createAgentSession: async (_options: CreateAgentSessionOptions) => session,
      resumeAgentSession: async () => session,
      nativeBackend: (options: NativeBackendOptions) => { native.push(options); return sentinel; },
      acpBackend: () => sentinel,
      createFileTranscriptStore: (directory: string) => createFileTranscriptStore(directory),
    },
  });
  const result = await factory.open({
    jobId: 'job-1', thread: thread({ mode }), worktree: '/work/tree', tools: [], approvalTimeoutSec: 60,
  });
  expect(result.ok).toBe(true);
  const options = native[0];
  if (options === undefined) throw new Error('the factory opened no native backend');
  return options;
}

test('B2: a native full-mode session raises no Bash approval at all', async () => {
  const options = await openNative('full');
  const { rules, asks } = resolved('full', options);

  expect(rules.bashApproval).toBe('raw');
  expect(asks.filter((rule) => rule.tool === 'Bash')).toHaveLength(0);
  // Full keeps its tools: the no-prompts mode must not become a read-only mode either.
  expect(asks).toHaveLength(0);
});

test('B2: a native ask-mode session still asks before every Bash command', async () => {
  const options = await openNative('ask');
  const { rules, asks } = resolved('ask', options);

  expect(rules.bashApproval).toBe('gated');
  expect(asks.find((rule) => rule.tool === 'Bash')).toEqual({ tool: 'Bash', patterns: ['*'] });
  // The ask profile also gates the mutating path tools, exactly as before this fix.
  for (const tool of ['Write', 'Edit', 'Delete']) {
    expect(asks.some((rule) => rule.tool === tool)).toBe(true);
  }
});

test('B2: a native read-mode session passes no bashApproval, which the package refuses for that profile', async () => {
  const options = await openNative('read');

  expect(options).not.toHaveProperty('bashApproval');
  expect(options).not.toHaveProperty('allowUnsandboxed');
  const { rules, asks } = resolved('read', options);
  // Read has no tool that could ask, and the package's own default is what applies.
  expect(rules.bashApproval).toBe('gated');
  expect(asks).toHaveLength(0);
});

test('B2: a gated full-mode session is exactly what the fix avoids (guard on the package default)', async () => {
  // The regression this pins: the package default for a full profile, with no explicit mode, is `gated`.
  const gated = resolved('full', { model: 'm/x' } as NativeBackendOptions);
  expect(gated.rules.bashApproval).toBe('gated');
  expect(gated.asks.find((rule) => rule.tool === 'Bash')).toEqual({ tool: 'Bash', patterns: ['*'] });
});
