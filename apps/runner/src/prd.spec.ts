import { describe, expect, test } from 'bun:test';
import { parsePrd } from './prd';

describe('parsePrd', () => {
  test('reads the story count and the branch name', () => {
    expect(parsePrd('{"branchName":" feat/x ","userStories":[{"id":"US-001"},{"id":"US-002"}]}')).toEqual({ stories: 2, branchName: 'feat/x' });
  });
  test('missing or non-string branch names are null, missing stories are 0', () => {
    expect(parsePrd('{}')).toEqual({ stories: 0, branchName: null });
    expect(parsePrd('{"branchName":7,"userStories":"x"}')).toEqual({ stories: 0, branchName: null });
    expect(parsePrd('{"branchName":"  "}')).toEqual({ stories: 0, branchName: null });
  });
  test.each(['', 'not json', '[]', '"s"', 'null', '7'])('%j is not a PRD object', (text) => {
    expect(parsePrd(text)).toBeNull();
  });
});
