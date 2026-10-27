import { NotFoundAppException } from '@nathapp/nestjs-common';
import { getActionTool } from './action-tools';
import type { ToolContext } from '../assistant-tool.types';

const ctx = { projectId: 'p', threadId: 't', data: (text: string) => `<fence>${text}</fence>` } as ToolContext;
describe('thread action request reads', () => {
  it('AC-13: reads a scoped request and prints lowercase status and request timestamp', async () => {
    const findScopedInThread = vi.fn(async () => ({ tool: 'koda_add_comment', request: { id: 'r', status: 'pending', createdAt: new Date('2026-11-01Z'), decidedAt: null, settledAt: null, result: null } }));
    const tool = getActionTool({ findScopedInThread } as never);
    expect(await tool.execute(ctx, { id: 'r' })).toBe('action r koda_add_comment pending\nrequested 2026-11-01T00:00:00.000Z');
    expect(findScopedInThread).toHaveBeenCalledWith('r', 'p', 't');
  });
  it('AC-14: a scoped miss is not_found', async () => {
    const findScopedInThread = vi.fn(async () => null);
    const tool = getActionTool({ findScopedInThread } as never);
    await expect(tool.execute(ctx, { id: 'foreign' })).rejects.toBeInstanceOf(NotFoundAppException);
    expect(findScopedInThread).toHaveBeenCalledWith('foreign', 'p', 't');
  });
  it('prints decision, settlement and fenced result text', async () => {
    const at = new Date('2026-11-01Z');
    const tool = getActionTool({ findScopedInThread: vi.fn(async () => ({ tool: 'koda_add_comment', request: { id: 'r', status: 'executed', createdAt: at, decidedAt: at, settledAt: at, result: { text: 'done' } } })) } as never);
    expect(await tool.execute(ctx, { id: 'r' })).toContain('decided 2026-11-01T00:00:00.000Z\nsettled 2026-11-01T00:00:00.000Z\nresult:\n<fence>done</fence>');
  });
});
