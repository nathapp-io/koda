// Imported first: ts-morph and @nestjs/common decorators need the metadata polyfill.
import 'reflect-metadata';
import { CodeGraphService } from './code-graph.service';
import { runExtractionRequest } from './extraction-protocol';

async function readRequest(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The extraction child: one batch request on stdin, one response on stdout, then exit.
 *
 * `ChildProcessCodeExtractor` spawns this script (built to `dist/code-intel/`) per batch, so
 * the compiler's heap dies with the process instead of staying in the api process.
 */
async function main(): Promise<void> {
  const input = await readRequest();
  process.stdout.write(runExtractionRequest(input, new CodeGraphService()));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
