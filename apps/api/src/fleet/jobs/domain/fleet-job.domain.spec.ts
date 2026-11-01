import { fixOutcomeOf } from './fleet-job.domain';

describe('fixOutcomeOf (US-004 AC-5..AC-6)', () => {
  it('AC-5: keeps the two outcome values the runner may report', () => {
    expect(fixOutcomeOf('pushed')).toBe('pushed');
    expect(fixOutcomeOf('nothing')).toBe('nothing');
  });

  it('AC-6: maps any other stored value, and null, to null', () => {
    expect(fixOutcomeOf('other')).toBeNull();
    expect(fixOutcomeOf(null)).toBeNull();
  });

  it('maps undefined, an empty string and a differently cased value to null', () => {
    expect(fixOutcomeOf(undefined)).toBeNull();
    expect(fixOutcomeOf('')).toBeNull();
    expect(fixOutcomeOf('PUSHED')).toBeNull();
  });
});
