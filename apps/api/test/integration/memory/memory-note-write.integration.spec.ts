/**
 * US-001 — storing a NOTE memory item through `POST /memory`, and the slug-keyed supersession it gets.
 *
 * A note is a `MemoryItem` with `kind: 'NOTE'`: `subject` is the slug, `predicate` the type, `object` the
 * Markdown body and `description` the index line. Its active key is `NOTE:<slug>`, so re-saving a slug with a
 * new type, body or description supersedes the note already stored, while an identical restatement from the
 * same source is the existing no-op. The REST route validates through the same pure `noteFieldError` the
 * assistant tool calls (US-002), before anything is read or written.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx vitest run test/integration/memory/memory-note-write.integration.spec.ts
 */
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NathApplication } from '@nathapp/nestjs-app';
import { MemoryKind } from '../../../src/common/enums';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** `memory.-2` — the sentence `GlobalExceptionsFilter` renders for a ValidationAppException in this domain. */
const MEMORY_CATALOG = JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/memory.json'), 'utf8'),
) as Record<string, string>;

/** The 400 message for a refused memory write, naming the field it refused. */
const invalidField = (field: string): string => MEMORY_CATALOG['-2'].replace('{field}', field);

/** The note every test starts from; each test changes what it is about. */
const note = (over: Record<string, unknown> = {}) => ({
  kind: MemoryKind.NOTE,
  subject: 'replay-budget',
  predicate: 'project',
  object: 'Budget stays 2,048 MiB.',
  description: 'replay budget',
  ...over,
});

describeIntegration('memory notes: POST /memory and slug-keyed supersession (US-001)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  /** The API's own repository, running as the system writer a direct upsert is made by. */
  let repository: PrismaMemoryItemRepository;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  /** POST /memory as `dev`, a developer (project member) of the `web` project the world seeds. */
  const postMemory = (body: Record<string, unknown>) =>
    request(server()).post('/api/memory').set(auth(world.tokens.dev)).send({ projectId: world.projectId, ...body });
  const rowsOf = (subject: string) =>
    db.memoryItem.findMany({ where: { projectId: world.projectId, subject }, orderBy: { createdAt: 'asc' } });
  /** The note as the repository takes it: the project's note, plus whatever the test changes. */
  const storedNote = (over: Record<string, unknown> = {}) => ({ projectId: world.projectId, ...note(over) });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    repository = asTestActor(app.get(PrismaMemoryItemRepository), { type: 'SYSTEM', id: 'outbox' });
  }, 120000);

  beforeEach(async () => {
    resetThrottle(app);
    // Each test writes the rows it reads: the note slugs below are the same in every test on purpose.
    await db.memoryItem.deleteMany({ where: { projectId: world.projectId } });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AC-12: POST /memory stores a NOTE with its index line for a project member', async () => {
    const response = await postMemory(note()).expect(201);

    const created = data<{ id: string; kind: string; description?: string }>(response);
    expect(created).toMatchObject({ kind: 'NOTE', description: 'replay budget' });
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      projectId: world.projectId,
      kind: 'NOTE',
      subject: 'replay-budget',
      predicate: 'project',
      object: 'Budget stays 2,048 MiB.',
      description: 'replay budget',
      status: 'active',
      activeKey: 'NOTE:replay-budget',
    });
  });

  it('AC-13: re-saving a note slug with another type supersedes the note already active', async () => {
    const first = await repository.upsert(storedNote());
    const second = await repository.upsert(storedNote({ predicate: 'feedback', object: 'Feedback lands in the thread.' }));

    const rows = await rowsOf('replay-budget');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.id)).toMatchObject({ status: 'superseded', activeKey: null });
    expect(rows.find((row) => row.id === second.id)).toMatchObject({
      status: 'active',
      activeKey: 'NOTE:replay-budget',
      predicate: 'feedback',
    });
  });

  it('AC-14: restating the whole note from the same source writes no row', async () => {
    const restated = storedNote({ sourceType: 'manual', sourceId: 'note-replay-budget' });

    const first = await repository.upsert(restated);
    const replay = await repository.upsert(restated);

    expect(replay.id).toBe(first.id);
    expect(await rowsOf('replay-budget')).toHaveLength(1);
  });

  it('AC-14: re-saving the same note through the route, with no source named, writes no row', async () => {
    // The REST route defaults `sourceType` to `manual` and leaves `sourceId` out entirely, so the stored row
    // carries a null `sourceId` while the replay carries `undefined`: one source, so one note — no supersede,
    // no second insert, and no second audit entry on a write that changed nothing.
    const first = data<{ id: string }>(await postMemory(note()).expect(201));
    const replay = data<{ id: string }>(await postMemory(note()).expect(201));

    expect(replay.id).toBe(first.id);
    expect(await rowsOf('replay-budget')).toHaveLength(1);
    expect(await db.auditEntry.count({ where: { resourceId: first.id, key: 'memory.create' } })).toBe(1);
  });

  it('AC-15: a note differing from the active one only in its index line supersedes it', async () => {
    const source = { sourceType: 'manual', sourceId: 'note-replay-budget' };
    const first = await repository.upsert(storedNote(source));
    const second = await repository.upsert(storedNote({ ...source, description: 'replay budget, revised' }));

    expect(second.id).not.toBe(first.id);
    const rows = await rowsOf('replay-budget');
    expect(rows.find((row) => row.id === first.id)).toMatchObject({ status: 'superseded', activeKey: null });
    expect(rows.find((row) => row.id === second.id)).toMatchObject({
      status: 'active',
      description: 'replay budget, revised',
    });
  });

  it('AC-16: a note the validator refuses answers 400 naming the field and writes nothing', async () => {
    const response = await postMemory(note({ subject: 'Replay Budget' })).expect(400);

    expect(response.body).toMatchObject({ ret: -2, message: invalidField('subject') });
    expect(await db.memoryItem.count({ where: { projectId: world.projectId } })).toBe(0);
  });

  it('AC-17: a triple write carrying a description answers 400 naming description', async () => {
    const response = await postMemory({
      kind: MemoryKind.FACT, subject: 'budget', predicate: 'stays', object: '2048 MiB', description: 'not a note',
    }).expect(400);

    expect(response.body).toMatchObject({ ret: -2, message: invalidField('description') });
    expect(await db.memoryItem.count({ where: { projectId: world.projectId } })).toBe(0);
  });

  it('AC-17: a triple write carrying a blank description is refused, never stored as an empty string', async () => {
    const response = await postMemory({
      kind: MemoryKind.FACT, subject: 'budget-blank', predicate: 'stays', object: '2048 MiB', description: '   ',
    }).expect(400);

    expect(response.body).toMatchObject({ ret: -2, message: invalidField('description') });
    expect(await db.memoryItem.count({ where: { projectId: world.projectId } })).toBe(0);
  });
});
