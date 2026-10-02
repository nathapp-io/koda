import { InvalidArgumentError } from 'commander';
import { parseBudgetUsd, parseUsd } from './parse-usd';

describe('parseUsd', () => {
  it.each([['5', 5], ['0.0001', 0.0001], ['10000', 10000], [' 2.5 ', 2.5]])('accepts %s', (raw, value) => {
    expect(parseUsd(raw)).toBe(value);
  });

  it.each(['0', '-1', '1e3', '0.00001', '10000.01', 'abc', '', '1.', '.5', '0x10'])('rejects %p', (raw) => {
    expect(() => parseUsd(raw)).toThrow(InvalidArgumentError);
  });
});

describe('parseBudgetUsd', () => {
  it.each([['5', 5], ['250000', 250000], ['1000000', 1000000], ['0.0001', 0.0001]])('accepts %s', (raw, value) => {
    expect(parseBudgetUsd(raw)).toBe(value);
  });

  it.each(['0', '1000000.01', '1e6', 'abc'])('rejects %p', (raw) => {
    expect(() => parseBudgetUsd(raw)).toThrow(InvalidArgumentError);
  });
});
