import { KeyedMutex } from './keyed-mutex';

const tick = () => new Promise((r) => setImmediate(r));

describe('KeyedMutex', () => {
  it('runs sections for one key one at a time, in order, and other keys in parallel', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    let releaseA!: () => void;
    const a = m.run('k', async () => { order.push('a-start'); await new Promise<void>((r) => { releaseA = r; }); order.push('a-end'); });
    const b = m.run('k', async () => { order.push('b'); });
    const other = m.run('other', async () => { order.push('other'); });
    await tick();
    expect(order).toEqual(['a-start', 'other']);
    releaseA();
    await Promise.all([a, b, other]);
    expect(order).toEqual(['a-start', 'other', 'a-end', 'b']);
    await tick(); // the idle entry is dropped one microtask turn after the last section settles
    expect(m.size).toBe(0);
  });

  it('a failing section rejects its caller and does not block the next one', async () => {
    const m = new KeyedMutex();
    await expect(m.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(m.run('k', async () => 7)).resolves.toBe(7);
    await tick();
    expect(m.size).toBe(0);
  });
});
