import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const protocol = await import('@nathapp/fleet-protocol');
const nativeModelsModule = await import('../../src/thread/native-models').catch(() => undefined);
const credentialsModule = await import('../../src/thread/nax-credentials').catch(() => undefined);

const testRoot = join(import.meta.dir, `.thread-foundation-${crypto.randomUUID()}`);
let homeDir: string;

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
  homeDir = join(testRoot, 'nax-home');
  await mkdir(homeDir, { recursive: true });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function writeConfig(value: unknown): Promise<void> {
  await writeFile(join(homeDir, 'config.json'), JSON.stringify(value), 'utf8');
}

const configWithNativeModels = {
  models: {
    native: {
      fast: 'minimax/MiniMax-M2.7',
      balanced: { model: 'minimax/MiniMax-M3' },
      powerful: 'opencode-go/deepseek-v4.1-flash[high]',
    },
  },
};

describe('thread protocol contract (US-001)', () => {
  test('US-001 AC-1: exports the thread stream byte limits', () => {
    expect(protocol.THREAD_STREAM_LIMITS).toEqual({ lineMaxBytes: 65_536, streamMaxBytes: 209_715_200 });
  });

  test('US-001 AC-2: accepts a valid native model id', () => {
    expect(protocol.THREAD_MODEL_ID_RE).toBeInstanceOf(RegExp);
    expect(protocol.THREAD_MODEL_ID_RE.test('minimax/MiniMax-M3')).toBe(true);
  });

  test('US-001 AC-3: rejects a native model id with a tier suffix', () => {
    expect(protocol.THREAD_MODEL_ID_RE).toBeInstanceOf(RegExp);
    expect(protocol.THREAD_MODEL_ID_RE.test('opencode-go/deepseek-v4.1-flash[high]')).toBe(false);
  });
});

describe('native thread model discovery (US-001)', () => {
  test('US-001 AC-4: returns the available matching native models in tier order', async () => {
    expect(nativeModelsModule).toBeDefined();
    await writeConfig(configWithNativeModels);
    const result = await nativeModelsModule?.readNativeModels(homeDir, new Set(['minimax']));
    expect(result?.models).toEqual(['minimax/MiniMax-M2.7', 'minimax/MiniMax-M3']);
  });

  test('US-001 AC-5: chooses the available balanced model as default', async () => {
    expect(nativeModelsModule).toBeDefined();
    await writeConfig(configWithNativeModels);
    const result = await nativeModelsModule?.readNativeModels(homeDir, new Set(['minimax']));
    expect(result?.defaultModel).toBe('minimax/MiniMax-M3');
  });

  test('US-001 AC-6: removes a bracketed tier suffix before returning the model id', async () => {
    expect(nativeModelsModule).toBeDefined();
    await writeConfig(configWithNativeModels);
    const result = await nativeModelsModule?.readNativeModels(homeDir, new Set(['opencode-go']));
    expect(result?.models).toEqual(['opencode-go/deepseek-v4.1-flash']);
  });

  test('US-001 AC-7: falls back to the first kept model when balanced is unavailable', async () => {
    expect(nativeModelsModule).toBeDefined();
    await writeConfig(configWithNativeModels);
    const result = await nativeModelsModule?.readNativeModels(homeDir, new Set(['opencode-go']));
    expect(result?.defaultModel).toBe('opencode-go/deepseek-v4.1-flash');
  });

  test('US-001 AC-8: returns an empty model set when config.json is missing', async () => {
    expect(nativeModelsModule).toBeDefined();
    const missingHome = join(testRoot, 'missing-home');
    await mkdir(missingHome, { recursive: true });
    const result = await nativeModelsModule?.readNativeModels(missingHome, new Set());
    expect(result).toEqual({ models: [], defaultModel: null });
  });

  test('US-001 AC-9: returns an empty model set for invalid JSON', async () => {
    expect(nativeModelsModule).toBeDefined();
    await writeFile(join(homeDir, 'config.json'), '{not json', 'utf8');
    const result = await nativeModelsModule?.readNativeModels(homeDir, new Set());
    expect(result).toEqual({ models: [], defaultModel: null });
  });

  test('US-001 AC-10: returns duplicate model ids only once', async () => {
    expect(nativeModelsModule).toBeDefined();
    await writeConfig({ models: { native: { fast: 'minimax/MiniMax-M3', balanced: 'minimax/MiniMax-M3' } } });
    const result = await nativeModelsModule?.readNativeModels(homeDir, new Set(['minimax']));
    expect(result?.models).toEqual(['minimax/MiniMax-M3']);
  });

  test('US-001 AC-11: excludes model ids without a provider separator', async () => {
    expect(nativeModelsModule).toBeDefined();
    await writeConfig({ models: { native: { fast: 'MiniMax-M3' } } });
    const result = await nativeModelsModule?.readNativeModels(homeDir, new Set(['MiniMax-M3']));
    expect(result?.models).toEqual([]);
  });

  test('US-001 AC-12: returns distinct native providers in sorted order', async () => {
    expect(nativeModelsModule).toBeDefined();
    await writeConfig(configWithNativeModels);
    const result = await nativeModelsModule?.nativeModelProviders(homeDir);
    expect(result).toEqual(['minimax', 'opencode-go']);
  });
});

describe('nax credentials config reader (US-001)', () => {
  test('US-001 AC-13: defaults to file credentials with warn when config is missing', async () => {
    expect(credentialsModule).toBeDefined();
    const missingHome = join(testRoot, 'credentials-missing-home');
    await mkdir(missingHome, { recursive: true });
    const credentials = credentialsModule?.naxCredentialsConfig(missingHome);
    await expect(credentials?.readAuthConfig()).resolves.toEqual({ source: 'file', onChange: 'warn' });
  });

  test('US-001 AC-14: preserves a valid file auth configuration', async () => {
    expect(credentialsModule).toBeDefined();
    await writeConfig({ auth: { source: 'file', onChange: 'refuse' } });
    const credentials = credentialsModule?.naxCredentialsConfig(homeDir);
    await expect(credentials?.readAuthConfig()).resolves.toEqual({ source: 'file', onChange: 'refuse' });
  });

  test('US-001 AC-15: re-reads auth configuration on every call', async () => {
    expect(credentialsModule).toBeDefined();
    await writeConfig({ auth: { source: 'file', onChange: 'warn' } });
    const credentials = credentialsModule?.naxCredentialsConfig(homeDir);
    await expect(credentials?.readAuthConfig()).resolves.toEqual({ source: 'file', onChange: 'warn' });

    await writeConfig({ auth: { source: 'file', onChange: 'refuse' } });

    await expect(credentials?.readAuthConfig()).resolves.toEqual({ source: 'file', onChange: 'refuse' });
  });
});
