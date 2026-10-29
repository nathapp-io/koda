import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { KnowledgeIndexAdmin } from './knowledge-index-admin.service';
import { KnowledgeRouteCommands, KNOWLEDGE_ROUTE_VARIANTS } from './knowledge-route.commands';

function build() {
  const registry = new ApprovalCommandRegistry();
  const admin = { savePatterns: vi.fn().mockResolvedValue({ patterns: ['docs/**/*.md'], custom: true, queued: 1 }), reindex: vi.fn().mockResolvedValue({ queued: true }) };
  const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1', actorType: 'agent' }) };
  new KnowledgeRouteCommands(registry, admin as unknown as KnowledgeIndexAdmin, loader as unknown as ActorPrincipalLoader).onModuleInit();
  return { registry, admin };
}
describe('KnowledgeRouteCommands', () => {
  it('AC-14: registers the two project knowledge variants', () => {
    const { registry } = build();
    expect(registry.get('fleet.knowledge.patterns.update', 'rest:project-knowledge.patterns')?.key).toBe('fleet.knowledge.patterns.update');
    expect(registry.get('fleet.knowledge.repo.reindex', 'rest:project-knowledge.reindex')?.key).toBe('fleet.knowledge.repo.reindex');
  });
  it('AC-15: refuses invalid patterns and preserves explicit null', () => {
    const { registry } = build();
    const command = registry.get('fleet.knowledge.patterns.update', KNOWLEDGE_ROUTE_VARIANTS.patterns);
    if (!command) throw new Error('Missing patterns command');
    const input = { slug: 'web', projectId: 'p1' };
    expect(() => command.parse({ ...input, patterns: [''] })).toThrow(ValidationAppException);
    try { command.parse({ ...input, patterns: [''] }); } catch (error) { expect(error).toMatchObject({ prefix: 'knowledge.input' }); }
    expect(command.parse({ ...input, patterns: null })).toEqual({ ...input, patterns: null });
  });
  it.each(['patterns', 'reindex'] as const)('executes %s with frozen ids and returns the result', async (method) => {
    const { registry, admin } = build();
    const command = registry.get(method === 'patterns' ? 'fleet.knowledge.patterns.update' : 'fleet.knowledge.repo.reindex', KNOWLEDGE_ROUTE_VARIANTS[method]);
    if (!command) throw new Error('Missing knowledge command');
    const input = { slug: 'web', projectId: 'p1', ...(method === 'patterns' ? { patterns: ['docs/**/*.md'] } : { repoId: 'r1' }) };
    const result = await command.execute(command.parse({ ...input, ignored: true }));
    expect(admin[method === 'patterns' ? 'savePatterns' : 'reindex']).toHaveBeenCalledExactlyOnceWith('p1', method === 'patterns' ? ['docs/**/*.md'] : 'r1');
    expect(command.toResult?.(result)).toEqual(result);
    for (const bad of [null, {}, { ...input, projectId: '' }, { ...input, slug: 7 }]) expect(() => command.parse(bad)).toThrow(ValidationAppException);
  });
});
