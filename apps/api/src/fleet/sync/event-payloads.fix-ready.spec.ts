import { interpretEvent } from './event-payloads';

describe('snapshot fixReady mirror (US-001)', () => {
  const patch = (fixReady?: unknown) => interpretEvent('snapshot', fixReady === undefined ? {} : { fixReady });

  it('AC-1: preserves markedReady and reply counts', () => {
    expect(patch({ markedReady: true, replied: 2, resolved: 1 })).toMatchObject({ kind: 'mirror', patch: { fixReady: { markedReady: true, replied: 2, resolved: 1 } } });
  });
  it('AC-2: preserves readyHeld', () => {
    expect(patch({ markedReady: false, readyHeld: 'CI failure: check:e2e' })).toMatchObject({ kind: 'mirror', patch: { fixReady: { markedReady: false, readyHeld: 'CI failure: check:e2e' } } });
  });
  it('AC-3: drops invalid markedReady', () => {
    const result = patch({ markedReady: 'yes' });
    expect(result.kind === 'mirror' && result.patch).not.toHaveProperty('fixReady');
  });
  it('AC-4: drops negative counts only', () => {
    expect(patch({ markedReady: true, replied: -1, resolved: 1 })).toMatchObject({ kind: 'mirror', patch: { fixReady: { markedReady: true, resolved: 1 } } });
  });
  it('AC-5: drops non-string readyHeld only', () => {
    expect(patch({ markedReady: true, readyHeld: 42 })).toMatchObject({ kind: 'mirror', patch: { fixReady: { markedReady: true } } });
  });
  it('AC-6: clips readyHeld to 500 characters', () => {
    const result = patch({ markedReady: true, readyHeld: 'x'.repeat(600) });
    expect(result.kind === 'mirror' && result.patch.fixReady?.readyHeld).toHaveLength(500);
  });
  it('AC-7: omission does not produce a clearing patch', () => {
    const result = patch();
    expect(result.kind === 'mirror' && result.patch).not.toHaveProperty('fixReady');
  });
});
