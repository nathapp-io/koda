import { modeAtLeast, strictestMode } from './approval-mode';

describe('approval mode ladder', () => {
  it('AC-11: compares tiers inclusively', () => {
    expect(modeAtLeast('agent', 'self')).toBe(true);
    expect(modeAtLeast('self', 'agent')).toBe(false);
    expect(modeAtLeast('none', 'none')).toBe(true);
  });
  it('AC-12: selects the strictest tier, defaulting to none', () => {
    expect(strictestMode('self', 'human', 'none')).toBe('human');
    expect(strictestMode()).toBe('none');
  });
});
