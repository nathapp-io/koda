import { InMemoryEntityStore } from './in-memory-entity-store';
import { EntityNodeType } from './dto/entity-graph.types';

describe('InMemoryEntityStore', () => {
  let store: InMemoryEntityStore;

  beforeEach(() => {
    store = new InMemoryEntityStore();
  });

  describe('upsertNode / findNodeByEntityId', () => {
    it('stores and retrieves a node', async () => {
      await store.upsertNode('p1', 'e1', EntityNodeType.TICKET, 'Ticket #1');
      const node = await store.findNodeByEntityId('p1', 'e1');
      expect(node).not.toBeNull();
      expect(node?.entityId).toBe('e1');
      expect(node?.label).toBe('Ticket #1');
    });

    it('returns null for unknown entityId', async () => {
      const node = await store.findNodeByEntityId('p1', 'missing');
      expect(node).toBeNull();
    });

    it('is scoped by projectId', async () => {
      await store.upsertNode('p1', 'e1', EntityNodeType.TICKET, 'P1 Ticket');
      const miss = await store.findNodeByEntityId('p2', 'e1');
      expect(miss).toBeNull();
    });

    it('overwrites existing node on second upsert', async () => {
      await store.upsertNode('p1', 'e1', EntityNodeType.TICKET, 'Old label');
      await store.upsertNode('p1', 'e1', EntityNodeType.TICKET, 'New label');
      const node = await store.findNodeByEntityId('p1', 'e1');
      expect(node?.label).toBe('New label');
    });

    it('stores optional metadata', async () => {
      await store.upsertNode('p1', 'e1', EntityNodeType.SERVICE, 'Agent A', { role: 'reviewer' });
      const node = await store.findNodeByEntityId('p1', 'e1');
      expect(node?.metadata).toEqual({ role: 'reviewer' });
    });
  });

  describe('findNodesByType', () => {
    it('returns only nodes of the requested type', async () => {
      await store.upsertNode('p1', 'e1', EntityNodeType.TICKET, 'T1');
      await store.upsertNode('p1', 'e2', EntityNodeType.SERVICE, 'A1');
      await store.upsertNode('p1', 'e3', EntityNodeType.TICKET, 'T2');
      const tickets = await store.findNodesByType('p1', EntityNodeType.TICKET);
      expect(tickets).toHaveLength(2);
      expect(tickets.map((n) => n.entityId).sort()).toEqual(['e1', 'e3']);
    });

    it('is scoped by projectId', async () => {
      await store.upsertNode('p1', 'e1', EntityNodeType.TICKET, 'T1');
      await store.upsertNode('p2', 'e2', EntityNodeType.TICKET, 'T2');
      const result = await store.findNodesByType('p1', EntityNodeType.TICKET);
      expect(result).toHaveLength(1);
    });
  });

  describe('upsertLink / findLinksBySource / findLinksByTarget', () => {
    it('stores a link and retrieves it by source', async () => {
      await store.upsertLink('p1', 'e1', 'e2', 'BLOCKS');
      const links = await store.findLinksBySource('p1', 'e1');
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ targetId: 'e2', relation: 'BLOCKS' });
    });

    it('stores a link and retrieves it by target', async () => {
      await store.upsertLink('p1', 'e1', 'e2', 'BLOCKS');
      const links = await store.findLinksByTarget('p1', 'e2');
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ sourceId: 'e1', relation: 'BLOCKS' });
    });

    it('updates metadata on duplicate upsert (same source, target, relation)', async () => {
      await store.upsertLink('p1', 'e1', 'e2', 'BLOCKS', { note: 'v1' });
      await store.upsertLink('p1', 'e1', 'e2', 'BLOCKS', { note: 'v2' });
      const links = await store.findLinksBySource('p1', 'e1');
      expect(links).toHaveLength(1);
      expect(links[0].metadata).toEqual({ note: 'v2' });
    });

    it('allows multiple distinct links from the same source', async () => {
      await store.upsertLink('p1', 'e1', 'e2', 'BLOCKS');
      await store.upsertLink('p1', 'e1', 'e3', 'RELATES_TO');
      const links = await store.findLinksBySource('p1', 'e1');
      expect(links).toHaveLength(2);
    });

    it('returns empty array for unknown source', async () => {
      const links = await store.findLinksBySource('p1', 'nobody');
      expect(links).toHaveLength(0);
    });
  });

  describe('deleteLinksBySource', () => {
    it('removes all links from a source', async () => {
      await store.upsertLink('p1', 'e1', 'e2', 'BLOCKS');
      await store.upsertLink('p1', 'e1', 'e3', 'RELATES_TO');
      await store.deleteLinksBySource('p1', 'e1');
      expect(await store.findLinksBySource('p1', 'e1')).toHaveLength(0);
    });

    it('removes reverse-index entries for each deleted link', async () => {
      await store.upsertLink('p1', 'e1', 'e2', 'BLOCKS');
      await store.deleteLinksBySource('p1', 'e1');
      expect(await store.findLinksByTarget('p1', 'e2')).toHaveLength(0);
    });

    it('is a no-op for unknown source', async () => {
      await expect(store.deleteLinksBySource('p1', 'nobody')).resolves.not.toThrow();
    });
  });

  describe('clear', () => {
    it('removes all nodes and links', async () => {
      await store.upsertNode('p1', 'e1', EntityNodeType.TICKET, 'T1');
      await store.upsertLink('p1', 'e1', 'e2', 'BLOCKS');
      store.clear();
      expect(await store.findNodeByEntityId('p1', 'e1')).toBeNull();
      expect(await store.findLinksBySource('p1', 'e1')).toHaveLength(0);
    });
  });
});
