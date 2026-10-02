import { addUsd } from './money';

describe('addUsd', () => {
  it('adds decimal strings exactly and keeps four decimals', () => {
    expect(addUsd('0.1', '0.2')).toBe('0.3000');
    expect(addUsd('1.2345', '0')).toBe('1.2345');
    expect(addUsd('99999999.9999', '0.0001')).toBe('100000000.0000');
  });
});
