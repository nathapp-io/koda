import { describe, expect, test } from 'bun:test';
import { RepoMutex } from './repo-mutex';

/** One macrotask: every already-resolved promise chain has run by the time this resolves. Ordering, not timing. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('RepoMutex (D28)', () => {
  test('serialises one key first-in first-out, whatever order the holders finish being ready', async () => {
    const mutex = new RepoMutex();
    const order: string[] = [];
    const hold = { a: deferred(), b: deferred(), c: deferred() };
    const worker = async (name: 'a' | 'b' | 'c') => {
      const release = await mutex.acquire('acme/app');
      order.push(`${name}:in`);
      await hold[name].promise;
      order.push(`${name}:out`);
      release();
    };
    const all = Promise.all([worker('a'), worker('b'), worker('c')]);
    await settle();
    expect(order).toEqual(['a:in']);                       // b and c wait behind a
    hold.c.resolve();
    await settle();
    expect(order).toEqual(['a:in']);                       // c is ready but may not jump the queue
    hold.a.resolve();
    await settle();
    expect(order).toEqual(['a:in', 'a:out', 'b:in']);
    hold.b.resolve();
    await all;
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
  });
  test('different keys do not wait for each other', async () => {
    const mutex = new RepoMutex();
    const releaseA = await mutex.acquire('a/x');
    let acquiredB = false;
    const pendingB = mutex.acquire('b/y').then((release) => { acquiredB = true; return release; });
    await settle();
    expect(acquiredB).toBe(true);                          // while a/x is still held
    expect(mutex.isLocked('a/x')).toBe(true);
    releaseA();
    (await pendingB)();
    expect(mutex.isLocked('a/x')).toBe(false);
    expect(mutex.isLocked('b/y')).toBe(false);
  });
  test('releasing twice is harmless and does not admit two holders', async () => {
    const mutex = new RepoMutex();
    const first = await mutex.acquire('k');
    const second = mutex.acquire('k');
    const third = mutex.acquire('k');
    first();
    first();
    const releaseSecond = await second;
    let thirdIn = false;
    void third.then(() => { thirdIn = true; });
    await settle();
    expect(thirdIn).toBe(false);
    releaseSecond();
    (await third)();
    expect(mutex.isLocked('k')).toBe(false);
  });
  test('a holder that throws still releases when the caller uses finally', async () => {
    const mutex = new RepoMutex();
    await (async () => {
      const release = await mutex.acquire('k');
      try { throw new Error('boom'); } finally { release(); }
    })().catch(() => undefined);
    expect(mutex.isLocked('k')).toBe(false);
  });
});
