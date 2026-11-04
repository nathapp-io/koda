/**
 * memory-notes US-004 — the scope of a memory item.
 *
 * `project` is what every row was before this story; `user` is a principal-owned note (US-004) that is stored
 * once and read in every project. The constants live in `src/common/enums.ts` with the other koda enums, never
 * as a Prisma enum.
 */
import { MemoryScope } from '../common/enums';

describe('MemoryScope (memory-notes US-004)', () => {
  it('AC-1: MemoryScope.USER is "user" and MemoryScope.PROJECT is "project"', () => {
    expect(MemoryScope.USER).toBe('user');
    expect(MemoryScope.PROJECT).toBe('project');
  });
});
