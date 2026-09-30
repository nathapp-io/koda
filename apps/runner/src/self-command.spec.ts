import { describe, expect, test } from 'bun:test';
import { selfCommand } from './self-command';

describe('selfCommand (D84)', () => {
  test('a compiled binary runs itself', () => {
    expect(selfCommand('/usr/local/bin/koda-runner', '/$bunfs/root/koda-runner')).toEqual(['/usr/local/bin/koda-runner']);
  });
  test('from source it is bun plus the entry file', () => {
    expect(selfCommand('/home/u/.bun/bin/bun', '/repo/apps/runner/src/main.ts')).toEqual(['/home/u/.bun/bin/bun', '/repo/apps/runner/src/main.ts']);
  });
});
