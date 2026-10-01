import { InvalidArgumentError } from 'commander';
import { parseUsd } from './parse-usd';

describe('parseUsd', () => {
  it.each([['5', 5], ['0.0001', 0.0001], ['10000', 10000], [' 2.5 ', 2.5]])('accepts %s', (raw, value) => {
    expect(parseUsd(raw)).toBe(value);
  });

  it.each(['0', '-1', '1e3', '0.00001', '10000.01', 'abc', '', '1.', '.5', '0x10'])('rejects %p', (raw) => {
    expect(() => parseUsd(raw)).toThrow(InvalidArgumentError);
  });
});
