/**
 * The @nestjs/swagger CLI plugin can emit `require(".bun/<pkg>@<ver>+<peer-hash>/...")`
 * for a DTO property typed with a package enum: it strips the path up to the FIRST
 * `node_modules/` only, which under Bun's isolated store leaves the store path. The
 * path resolves in the dev checkout but not in the production image (different peer
 * hash), so the API crashes at boot. The build guard must find every such require.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findStoreRequires } from '../../../scripts/check-dist-requires';

describe('findStoreRequires', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-requires-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, content: string) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  it('reports a require of a Bun store path, with file and line', () => {
    write(
      'outbox/dto/q.dto.js',
      [
        'const a = require("@nathapp/nestjs-outbox");',
        'return { enum: require(".bun/@nathapp+nestjs-outbox@3.3.0+0e6c/node_modules/x").S };',
      ].join('\n'),
    );

    expect(findStoreRequires(dir)).toEqual([
      { file: path.join('outbox', 'dto', 'q.dto.js'), line: 2 },
    ]);
  });

  it('also catches single quotes and dynamic import()', () => {
    write('a.js', "require('.bun/x');\nimport('.bun/y');");

    expect(findStoreRequires(dir).map((hit) => hit.line)).toEqual([1, 2]);
  });

  it('catches spacing, backticks, store paths behind node_modules, and .cjs/.mjs', () => {
    write('a.js', 'require (".bun/x");\nrequire(`.bun/x`);');
    write('b.cjs', 'require("../../node_modules/.bun/x");');
    write('c.mjs', 'import("/app/node_modules/.bun/x");');

    expect(findStoreRequires(dir)).toHaveLength(4);
  });

  it('ignores package, relative and non-js references', () => {
    write('ok.js', 'require("@nestjs/swagger");\nrequire("./.bun-cache/x");\nrequire("../y");');
    write('notes.d.ts', 'import(".bun/x");');
    write('ok.js.map', '{"sources":[".bun/x"]}');

    expect(findStoreRequires(dir)).toEqual([]);
  });
});
