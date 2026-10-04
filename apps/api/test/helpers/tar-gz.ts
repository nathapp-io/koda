import { pack } from 'tar-stream';
import { createGzip } from 'zlib';

export interface TarFile {
  name: string;
  body?: string | Buffer;
  type?: 'file' | 'symlink';
  linkname?: string;
  mtime?: Date;
}

/** Builds a tar.gz in memory, shaped like the runner's bundle (apps/runner/src/bundle/build-bundle.ts). */
export function tarGz(files: TarFile[]): Promise<Buffer> {
  const p = pack();
  for (const f of files) {
    if (f.type === 'symlink') p.entry({ name: f.name, type: 'symlink', linkname: f.linkname ?? '', mtime: f.mtime });
    else p.entry({ name: f.name, mtime: f.mtime }, typeof f.body === 'string' ? Buffer.from(f.body) : (f.body ?? Buffer.alloc(0)));
  }
  p.finalize();
  const gz = p.pipe(createGzip());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    gz.on('data', (c: Buffer) => chunks.push(c));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
  });
}
