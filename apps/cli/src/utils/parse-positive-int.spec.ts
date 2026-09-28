import { InvalidArgumentError } from 'commander';
import { parsePositiveInt } from './parse-positive-int';

describe('parsePositiveInt', () => {
  it.each([['1', 1], ['20', 20], [' 7 ', 7], ['3600000', 3600000]])('parses %p', (raw, expected) => {
    expect(parsePositiveInt(raw)).toBe(expected);
  });

  it.each(['abc', '', '0', '-5', '1.5', '1e3', '0x10', '12abc', '9007199254740993'])('rejects %p', (raw) => {
    expect(() => parsePositiveInt(raw)).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt(raw)).toThrow('must be a positive integer');
  });
});
