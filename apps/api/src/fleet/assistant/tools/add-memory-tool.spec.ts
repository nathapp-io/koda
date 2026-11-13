import type { MemoryItem } from '../../../memory/memory-item-repository';
import type { PrismaMemoryItemRepository } from '../../../memory/prisma-memory-item.repository';
import { MemoryReplaceRefusedError, type MemoryWriteGuard } from '../../../memory/memory-write.guard';
import type { AuditRecorder } from '../../../audit/audit-recorder.service';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { addMemoryTool, type AddMemoryInput } from './add-memory-tool';

const ctx = {
  projectId: 'project-1', projectSlug: 'web', actor: { id: 'dev-1', actorType: 'user', email: 'dev@koda.test' },
  threadId: 'thread-1', jobId: 'job-1', now: new Date('2026-10-23T09:00:00.000Z'), data: (text: string) => text,
} as unknown as ToolContext;
const item = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'm1', projectId: 'project-1', kind: 'NOTE', subject: 'deploy-steps', predicate: 'project',
  status: 'active', confidence: 0.8, createdAt: new Date(0), updatedAt: new Date(0), ...over,
}) as MemoryItem;
type UpsertArgs = Parameters<PrismaMemoryItemRepository['upsert']>[0];
type UpsertOptions = NonNullable<Parameters<PrismaMemoryItemRepository['upsert']>[1]>;
function toolDeps(over: { active?: MemoryItem | null; saved?: MemoryItem; refusesReplace?: boolean; failsReplace?: boolean } = {}) {
  const findActive = vi.fn(async () => over.active ?? null);
  const beforeSupersede = vi.fn(async (): Promise<void> => { if (over.refusesReplace) throw new MemoryReplaceRefusedError('m1'); });
  const upsert = vi.fn(async (_item: UpsertArgs, _options?: UpsertOptions) => {
    if (over.failsReplace) throw new MemoryReplaceRefusedError('m1');
    return over.saved ?? item({ id: 'm3' });
  });
  const guard = {
    assertMayReplace: vi.fn(async () => { if (over.refusesReplace) throw new MemoryReplaceRefusedError('m1'); }),
    replaceCheck: vi.fn(() => beforeSupersede),
  };
  const memory = { findActive, upsert } as unknown as PrismaMemoryItemRepository;
  const record = vi.fn(async (): Promise<void> => undefined);
  const audit = { record } as unknown as AuditRecorder;
  return { findActive, upsert, guard, beforeSupersede, record,
    tool: addMemoryTool({ memory, guard: guard as unknown as MemoryWriteGuard, audit }) };
}
function reasonOf(run: () => unknown): string {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(ToolInputError);
    return (error as ToolInputError).reason;
  }
  throw new Error('expected the parser to refuse this input');
}
function previewOf(tool: AssistantTool<AddMemoryInput>, input: AddMemoryInput): Promise<string> {
  if (!tool.preview) throw new Error('koda_add_memory declares no preview');
  return tool.preview(ctx, input);
}
const valid = { slug: 'deploy-steps', type: 'project', description: 'How to deploy', body: 'Run deploy.sh' };
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

describe('koda_add_memory notes (US-002)', () => {
  it('AC-1: parses a valid note exactly', () => {
    expect(toolDeps().tool.parse(valid)).toEqual(valid);
  });
  it('AC-2: drops all keys except the four note fields', () => {
    expect(toolDeps().tool.parse({ ...valid, ownerId: 'someone-else', kind: 'FACT', subject: 'legacy' })).toEqual(valid);
  });
  it('AC-3: invalid slug is refused as slug', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, slug: 'Deploy Steps' }))).toBe('slug');
  });
  it('AC-4: invalid type is refused as type', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, type: 'constraint' }))).toBe('type');
  });
  it('AC-5: missing description is refused as description', () => {
    const { description: _description, ...input } = valid;
    expect(reasonOf(() => toolDeps().tool.parse(input))).toBe('description');
  });
  it('AC-6: blank body is refused as body', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, body: '   ' }))).toBe('body');
  });
  it('AC-7: a legacy triple without slug is refused as slug', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ kind: 'FACT', subject: 'api', predicate: 'runs on', object: 'bun' }))).toBe('slug');
  });
  it('AC-8: required field type checks finish before note validation', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ slug: 'Bad Slug', type: 5, description: 'd', body: 'b' }))).toBe('type');
  });
  it('AC-9: preview is exactly the three requested note lines', async () => {
    expect(await previewOf(toolDeps().tool, toolDeps().tool.parse(valid)))
      .toBe('Remember in web: NOTE deploy-steps / project\nHow to deploy\nRun deploy.sh');
  });
  it('AC-10: execute upserts the mapped NOTE and preserves attribution, replacement and audit hooks', async () => {
    const { upsert, tool } = toolDeps();
    await tool.execute(ctx, tool.parse(valid));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', kind: 'NOTE', subject: 'deploy-steps', predicate: 'project',
      object: 'Run deploy.sh', description: 'How to deploy', sourceType: 'thread', sourceId: 'thread-1',
      confidence: 0.8, ownerId: 'dev-1', ownerType: 'USER',
    }), { beforeSupersede: expect.any(Function), onWritten: expect.any(Function) });
  });
  it('AC-11: the first missing or non-string required field is refused in specified order', () => {
    for (const [key, expected] of [['slug', 'slug'], ['type', 'type'], ['body', 'body'], ['description', 'description']] as const) {
      const missing = { ...valid } as Record<string, unknown>;
      delete missing[key];
      expect(reasonOf(() => toolDeps().tool.parse(missing))).toBe(expected);
      expect(reasonOf(() => toolDeps().tool.parse({ ...valid, [key]: 7 }))).toBe(expected);
    }
    // Each earlier field wins over a later one that is bad too, so the order is pinned, not just slug-first.
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, slug: 7, type: 7, body: 7, description: 7 }))).toBe('slug');
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, type: 7, body: 7, description: 7 }))).toBe('type');
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, body: 7, description: 7 }))).toBe('body');
    const missingBody = { ...valid, description: 7 } as Record<string, unknown>;
    delete missingBody['body'];
    expect(reasonOf(() => toolDeps().tool.parse(missingBody))).toBe('body');
  });
  it('AC-12: translates each noteFieldError result to the tool field', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, slug: 'Bad Slug' }))).toBe('slug');
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, type: 'misc' }))).toBe('type');
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, body: '' }))).toBe('body');
    expect(reasonOf(() => toolDeps().tool.parse({ ...valid, description: ' ' }))).toBe('description');
  });
  it('shows replacement by note id and masks secrets without writing during preview', async () => {
    const { findActive, upsert, tool } = toolDeps({ active: item({ id: 'm9', object: 'old body' }) });
    const preview = await previewOf(tool, tool.parse({ ...valid, body: `token=${TOKEN}` }));
    expect(preview).toContain('Replaces memory:m9');
    expect(preview).not.toContain(TOKEN);
    expect(preview).toContain('token=[masked]');
    expect(findActive).toHaveBeenCalledWith('project-1', 'NOTE', valid.slug, valid.type);
    expect(upsert).not.toHaveBeenCalled();
  });
  it('checks the NOTE key in the preview and carries the transaction replace check into upsert', async () => {
    const { guard, beforeSupersede, upsert, tool } = toolDeps();
    await previewOf(tool, tool.parse(valid));
    expect(guard.assertMayReplace).toHaveBeenCalledWith(ctx.actor, 'project-1', {
      kind: 'NOTE', subject: valid.slug, predicate: valid.type,
    });
    await tool.execute(ctx, tool.parse(valid));
    expect(guard.replaceCheck).toHaveBeenCalledWith(ctx.actor, 'project-1');
    expect(upsert.mock.calls[0]?.[1]).toEqual({ beforeSupersede, onWritten: expect.any(Function) });
  });
  it('stores an agent owner as AGENT', async () => {
    const { upsert, tool } = toolDeps();
    const agentCtx = { ...ctx, actor: { ...ctx.actor, actorType: 'agent', id: 'agent-1' } } as unknown as ToolContext;
    await tool.execute(agentCtx, tool.parse(valid));
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({ ownerId: 'agent-1', ownerType: 'AGENT' });
  });
  it('propagates audit failures instead of hiding them', async () => {
    const beforeSupersede = vi.fn(async (): Promise<void> => undefined);
    const upsert = vi.fn(async (_input: UpsertArgs, options?: UpsertOptions) => {
      await options?.onWritten?.({ item: { id: 'm-1', projectId: 'project-1', kind: 'NOTE' } as MemoryItem, superseded: null });
      return item({ id: 'm-1' });
    });
    const guard = { assertMayReplace: vi.fn(async () => undefined), replaceCheck: vi.fn(() => beforeSupersede) };
    const tool = addMemoryTool({
      memory: { findActive: vi.fn(async () => null), upsert } as unknown as PrismaMemoryItemRepository,
      guard: guard as unknown as MemoryWriteGuard,
      audit: { record: vi.fn(async () => { throw new Error('audit down'); }) } as unknown as AuditRecorder,
    });
    await expect(tool.execute(ctx, tool.parse(valid))).rejects.toThrow('audit down');
  });
  it('refuses a replacement without memory.update during preview', async () => {
    const { guard, upsert, tool } = toolDeps({ refusesReplace: true });
    await expect(previewOf(tool, tool.parse(valid))).rejects.toBeInstanceOf(ToolForbiddenError);
    expect(guard.replaceCheck).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
  it('returns the saved memory id', async () => {
    const { tool } = toolDeps({ saved: item({ id: 'm4' }) });
    await expect(tool.execute(ctx, tool.parse(valid))).resolves.toBe('memory:m4 saved');
  });
  it('runs the audit hook through upsert and records a NOTE creation', async () => {
    const record = vi.fn(async (): Promise<void> => undefined);
    const beforeSupersede = vi.fn(async (): Promise<void> => undefined);
    const upsert = vi.fn(async (_input: UpsertArgs, options?: UpsertOptions) => {
      await options?.onWritten?.({ item: { id: 'm-1', projectId: 'project-1', kind: 'NOTE' } as MemoryItem, superseded: null });
      return item({ id: 'm-1' });
    });
    const guard = { assertMayReplace: vi.fn(async () => undefined), replaceCheck: vi.fn(() => beforeSupersede) };
    const tool = addMemoryTool({
      memory: { findActive: vi.fn(async () => null), upsert } as unknown as PrismaMemoryItemRepository,
      guard: guard as unknown as MemoryWriteGuard,
      audit: { record } as unknown as AuditRecorder,
    });
    await tool.execute(ctx, tool.parse(valid));
    expect(record).toHaveBeenCalledWith({
      key: 'memory.create', resourceType: 'memory-item', resourceId: 'm-1', projectId: 'project-1', summary: 'created NOTE',
    });
  });
  it('turns a concurrent replacement refusal into a forbidden action', async () => {
    const { tool } = toolDeps({ failsReplace: true });
    await expect(tool.execute(ctx, tool.parse(valid))).rejects.toBeInstanceOf(ToolActionError);
    // The refusal the agent reads names the key an approval would need, as the decision tool's does.
    await expect(tool.execute(ctx, tool.parse(valid))).rejects.toMatchObject({
      text: 'forbidden: memory:m1 needs memory.update',
    });
  });
});
