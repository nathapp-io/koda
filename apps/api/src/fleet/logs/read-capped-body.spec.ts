import { Readable } from 'stream';
import { readCappedBody } from './read-capped-body';

describe('readCappedBody', () => {
  it('reads a body up to the cap', async () => {
    await expect(readCappedBody(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4)).resolves.toEqual({ ok: 'yes', bytes: Buffer.from('abcd') });
  });

  it('a body just past the cap is drained and refused (so the 413 can be sent)', async () => {
    await expect(readCappedBody(Readable.from([Buffer.alloc(20), Buffer.alloc(20)]), 25)).resolves.toEqual({ ok: 'too_large' });
  });

  it('stops reading a body far past the cap, whatever Content-Length said', async () => {
    let pulled = 0;
    const source = Readable.from((function* () { for (let i = 0; i < 100; i += 1) { pulled += 1; yield Buffer.alloc(10); } })());
    await expect(readCappedBody(source, 25)).resolves.toEqual({ ok: 'too_large' });
    expect(pulled).toBeLessThan(100);
  });

  it('an empty body is an empty buffer', async () => {
    await expect(readCappedBody(Readable.from([]), 4)).resolves.toEqual({ ok: 'yes', bytes: Buffer.alloc(0) });
  });
});
