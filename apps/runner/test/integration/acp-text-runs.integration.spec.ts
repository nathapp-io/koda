import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createAgentSession, createMemoryTranscriptStore } from '@nathapp/nax-agent';
import { acpBackend } from '@nathapp/nax-agent-acp/client';

const workdirs: string[] = [];

afterEach(async () => {
  await Promise.all(workdirs.splice(0).map((workdir) => rm(workdir, { recursive: true, force: true })));
});

async function promptOutput(scenario: string): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), 'koda-acp-text-runs-'));
  workdirs.push(workdir);
  const fixture = join(__dirname, '../fixtures/fake-acp-agent.ts');
  const session = await createAgentSession({
    backend: acpBackend({
      agent: { name: 'fake', command: process.execPath, args: [fixture] },
      allowUnsandboxed: true,
      env: { FAKE_ACP_SCENARIO: scenario },
    }),
    profile: 'ask',
    workdir,
    tools: [],
    transcriptStore: createMemoryTranscriptStore(),
  });
  try {
    let lastEvent: { type: string; output?: string } | undefined;
    for await (const event of session.send('Please respond.')) lastEvent = event;
    expect(lastEvent?.type).toBe('turn_end');
    return lastEvent?.output ?? '';
  } finally {
    await session.close();
  }
}

describe('ACP text runs', () => {
  test('AC-1: separates assistant text around a tool call', async () => {
    expect(await promptOutput('tool-separated')).toBe('Checking the file.\n\nDone.');
  });

  test('AC-2: leaves adjacent assistant chunks joined without a tool call', async () => {
    expect(await promptOutput('adjacent')).toBe('Hello world');
  });
});
