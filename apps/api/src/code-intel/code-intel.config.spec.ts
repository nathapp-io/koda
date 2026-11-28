import { CodeGraphService } from './code-graph.service';
import { ChildProcessCodeExtractor } from './child-process-code-extractor';
import { InProcessCodeExtractor } from './code-extractor';
import { createCodeExtractor, readCodeIntelConfig } from './code-intel.config';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}));

describe('code intel extraction configuration', () => {
  it('AC-1: defaults unset and empty modes to child', () => {
    expect(readCodeIntelConfig({})).toEqual({ extractionMode: 'child' });
    expect(readCodeIntelConfig({ CODE_INTEL_EXTRACTION_MODE: '' })).toEqual({ extractionMode: 'child' });
  });

  it('AC-2: accepts inprocess mode', () => {
    expect(readCodeIntelConfig({ CODE_INTEL_EXTRACTION_MODE: 'inprocess' })).toEqual({ extractionMode: 'inprocess' });
  });

  it('AC-3: names the invalid environment variable in its error', () => {
    expect(() => readCodeIntelConfig({ CODE_INTEL_EXTRACTION_MODE: 'thread' }))
      .toThrow('CODE_INTEL_EXTRACTION_MODE');
  });

  it('AC-4: creates an in-process extractor for inprocess mode', () => {
    expect(createCodeExtractor({ extractionMode: 'inprocess' }, new CodeGraphService()))
      .toBeInstanceOf(InProcessCodeExtractor);
  });

  it('AC-5: creates a child-process extractor without spawning a child', () => {
    spawnMock.mockClear();

    expect(createCodeExtractor({ extractionMode: 'child' }, new CodeGraphService()))
      .toBeInstanceOf(ChildProcessCodeExtractor);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
