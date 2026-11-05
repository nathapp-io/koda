import { validateCreateThread, validateCreateWorkspaceThread } from './thread-input';

const base = { title: 'Mode', backend: { kind: 'native' as const } };
describe('thread mode create normalization', () => {
  it('REPO defaults to read and preserves each explicit mode', () => {
    const input = { ...base, repoId: 'r', feature: 'f' };
    expect(validateCreateThread(input, 'main')).toHaveProperty('mode', 'read');
    for (const mode of ['read', 'ask', 'full'] as const) expect(validateCreateThread({ ...input, mode }, 'main')).toHaveProperty('mode', mode);
  });
  it('PROJECT and WORKSPACE omit read but reject elevated or invalid mode', () => {
    expect(validateCreateThread({ ...base, kind: 'PROJECT', mode: 'read' }, 'main')).not.toHaveProperty('mode');
    expect(validateCreateWorkspaceThread({ ...base, mode: 'read' })).not.toHaveProperty('mode');
    for (const mode of ['ask', 'full', 'bogus', false, '']) {
      expect(() => validateCreateThread({ ...base, kind: 'PROJECT', mode } as never, 'main')).toThrow(expect.objectContaining({ args: { reason: 'mode' } }));
      expect(() => validateCreateWorkspaceThread({ ...base, mode } as never)).toThrow(expect.objectContaining({ args: { reason: 'mode' } }));
    }
  });
});
