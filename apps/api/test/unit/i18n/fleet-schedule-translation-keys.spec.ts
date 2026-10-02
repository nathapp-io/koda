/**
 * S1b slice 3a — schedule error messages exist in en and zh with the same placeholders.
 * The key is `<prefix>.<code>`: NotFoundAppException uses 404, ValidationAppException -2.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

type Tree = Record<string, Record<string, string>>;
const load = (lang: string): Tree => JSON.parse(readFileSync(join(__dirname, '../../../src/i18n', lang, 'fleet.json'), 'utf8')) as Tree;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const KEYS: Array<[string, string, string[]]> = [
  ['schedules', '404', []],
  ['scheduleInput', '-2', ['reason']],
  ['scheduleCronTooFrequent', '-2', ['minutes']],
  ['scheduleOwnerNoAccess', '409', []],
];

describe('fleet schedule translation keys', () => {
  const en = load('en');
  const zh = load('zh');

  it.each(KEYS)('fleet.%s.%s exists in en and zh with the same placeholders', (group, code, expected) => {
    const enText = en[group]?.[code];
    const zhText = zh[group]?.[code];
    expect(typeof enText).toBe('string');
    expect(typeof zhText).toBe('string');
    expect(placeholders(enText)).toEqual(expected);
    expect(placeholders(zhText)).toEqual(expected);
  });
});
