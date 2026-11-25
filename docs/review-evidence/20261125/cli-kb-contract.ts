// Generate CLI response fixtures through the real KB controller and in-memory vector store.
// The CLI proof supplies the destination inside a temporary directory.
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { RagController } from '../../../apps/api/src/rag/rag.controller';
import { RagService } from '../../../apps/api/src/rag/rag.service';
import { VectorStore } from '../../../apps/api/src/rag/vector-store.service';
import { KbDocumentAddition } from '../../../apps/api/src/rag/kb-document-addition.service';
import { ragConfig } from '../../../apps/api/src/config/rag.config';

const project = { id: 'review', slug: 'review', deletedAt: null };
const principal = {
  actorType: 'user', id: 'author', name: 'Reviewer', role: 'MEMBER',
  email: 'author@example.invalid', authorities: [], blacklisted: false, revoked: false,
} as const;
const document = { source: 'doc' as const, sourceId: 'example.md', content: 'Review fixture' };
const config = { ...ragConfig(), inMemoryOnly: true };
// A transient provider error is a meaningful counterexample to the original finding.
const unavailableProvider = { embed: async () => { throw new Error('fixture outage'); }, dimensions: 3 };
function setup(withProvider: boolean) {
  const vector = new VectorStore(config, withProvider ? unavailableProvider as never : undefined);
  const rag = new RagService(vector);
  const audit = { audited: async (work: () => Promise<void>) => work() };
  const journal = {
    run: (id: string, work: Parameters<RagService['withDocumentWriteLock']>[1]) =>
      rag.withDocumentWriteLock(id, work),
    prepare: async () => ({ id: 'fixture-intent' }),
  };
  const addition = new KbDocumentAddition(rag, undefined as never, audit as never, journal as never);
  const gate = {
    run: async () => ({ status: 'executed', result: await addition.add(principal as never, project.id, document) }),
  };
  const projects = { findProjectBySlug: async () => project };
  const controller = new RagController(rag, undefined as never, projects as never, undefined as never,
    audit as never, undefined as never, gate as never);
  return { controller, add: () => controller.addDocument(project.slug, document, principal as never) };
}

async function main(): Promise<void> {
  const configured = setup(true);
  const empty = await configured.controller.listDocuments(project.slug);
  const stored = await configured.add();
  const one = await configured.controller.listDocuments(project.slug);
  const disabled = setup(false);
  const unindexed = await disabled.add();
  const stillEmpty = await disabled.controller.listDocuments(project.slug);
  const fixtures = JSON.parse(JSON.stringify({ empty, one, stored, unindexed }));
  assert.deepEqual(fixtures.empty.data, []);
  assert.equal(fixtures.one.data.length, 1);
  assert.equal(fixtures.stored.data.indexed, true);
  assert.equal(fixtures.unindexed.data.indexed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(stillEmpty)).data, []);
  assert.equal('docCount' in fixtures.stored.data, false);
  writeFileSync(process.argv[2], JSON.stringify(fixtures), { flag: 'wx' });
}

void main();
