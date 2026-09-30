import { stat } from 'node:fs/promises';

const MAX_READ_BYTES = 1_048_576;
const sizeOf = (path: string): Promise<number> => stat(path).then((s) => s.size, () => 0);

/** Reads what was appended since the last call. Whole lines only, unless `final` (the process has exited). */
export class FileTail {
  private constructor(private readonly path: string, private offset: number) {}

  static fromStart(path: string): FileTail {
    return new FileTail(path, 0);
  }

  static async fromEnd(path: string): Promise<FileTail> {
    return new FileTail(path, await sizeOf(path));
  }

  async readNew(final = false): Promise<string> {
    const size = await sizeOf(this.path);
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return '';
    const end = Math.min(size, this.offset + MAX_READ_BYTES);
    const buffer = Buffer.from(await Bun.file(this.path).slice(this.offset, end).arrayBuffer());
    let cut = final ? buffer.length : buffer.lastIndexOf(0x0a) + 1;
    if (cut === 0 && buffer.length >= MAX_READ_BYTES) cut = buffer.length; // one enormous line: do not wait forever
    if (cut === 0) return '';
    this.offset += cut;
    return buffer.subarray(0, cut).toString('utf8');
  }
}
