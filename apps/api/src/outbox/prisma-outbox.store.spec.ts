import { PrismaService } from '@nathapp/nestjs-prisma';
import { currentContext } from '../action-context/action-context';
import { SYSTEM_WRITER_METADATA } from '../permissions/system-writer.decorator';
import { PrismaOutboxStore } from './prisma-outbox.store';

type LazyResult = PromiseLike<{ count: number }>;

function lazyUpdateMany(observed: Array<ReturnType<typeof currentContext>>): LazyResult {
  return {
    then<TResult1 = { count: number }, TResult2 = never>(
      resolve?: ((value: { count: number }) => TResult1 | PromiseLike<TResult1>) | null,
      reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      observed.push(currentContext());
      return Promise.resolve({ count: 1 }).then(resolve, reject);
    },
  };
}

describe('PrismaOutboxStore system context', () => {
  let observed: Array<ReturnType<typeof currentContext>>;
  let store: PrismaOutboxStore;

  beforeEach(() => {
    observed = [];
    const client = { outboxEvent: { updateMany: vi.fn(() => lazyUpdateMany(observed)) } };
    store = new PrismaOutboxStore({ client } as unknown as PrismaService);
  });

  it('AC-1: awaits markPublished update in SYSTEM/outbox context', async () => {
    await store.markPublished('e1', new Date(), 'relay-1');
    expect(observed[0]?.actor).toEqual({ type: 'SYSTEM', id: 'outbox' });
  });

  it('AC-2: awaits markRetry update in SYSTEM/outbox context', async () => {
    await store.markRetry('e1', 2, new Date(), 'relay-1');
    expect(observed[0]?.actor).toEqual({ type: 'SYSTEM', id: 'outbox' });
  });

  it('AC-3: awaits markDead update in SYSTEM/outbox context', async () => {
    await store.markDead('e1', 5, 'relay-1');
    expect(observed[0]?.actor).toEqual({ type: 'SYSTEM', id: 'outbox' });
  });

  it('AC-4: declares the system.outbox.dispatch writer key', () => {
    expect(Reflect.getMetadata(SYSTEM_WRITER_METADATA, PrismaOutboxStore)).toBe('system.outbox.dispatch');
  });
});

