import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { CodeExtractor, CodeExtractionError } from './code-extractor';
import type { ExtractionFile } from './code-extractor';
import type { CodeExtractionFailure } from './code-extractor';
import type { FileExtraction } from './code-graph.service';

/** How long one extraction child may run before it is killed. */
export const EXTRACTION_TIMEOUT_MS = 120_000;

/** How much of the child's stderr an `exit` failure keeps for its message. */
const STDERR_TAIL_CHARS = 2_000;

function defaultCommand(): readonly string[] {
  // The built child script: `dist/code-intel/extraction-child.js` beside this file.
  return [process.execPath, join(__dirname, 'extraction-child.js')];
}

function parseResponse(stdout: string, expectedCount: number): FileExtraction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`response is not JSON (${(error as Error).message})`);
  }
  const results = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new Error('response has no results array');
  if (results.length !== expectedCount) {
    throw new Error(`response has ${results.length} results for ${expectedCount} files`);
  }
  return results as FileExtraction[];
}

/** Runs each extraction in its own short-lived child process, one child at a time. */
export class ChildProcessCodeExtractor extends CodeExtractor {
  private readonly command: readonly string[];
  private readonly timeoutMs: number;
  /** The last child this extractor started; a new extraction waits for it to settle. */
  private lastChild: Promise<void> = Promise.resolve();

  constructor(command: readonly string[] = defaultCommand(), timeoutMs: number = EXTRACTION_TIMEOUT_MS) {
    super();
    this.command = command;
    this.timeoutMs = timeoutMs;
  }

  extract(files: ReadonlyArray<ExtractionFile>): Promise<FileExtraction[]> {
    const extraction = this.lastChild.then(() => this.runChild(files));
    // Queue the next call on the settled outcome: one rejected extraction must not stop the queue.
    this.lastChild = extraction.then(
      () => undefined,
      () => undefined,
    );
    return extraction;
  }

  private runChild(files: ReadonlyArray<ExtractionFile>): Promise<FileExtraction[]> {
    return new Promise<FileExtraction[]>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        action();
      };
      const fail = (reason: CodeExtractionFailure, message: string): void => {
        settle(() => reject(new CodeExtractionError(reason, message)));
      };

      const [file, ...args] = this.command;
      let child: ChildProcess;
      try {
        child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        fail('spawn', `code extraction child could not be started: ${(error as Error).message}`);
        return;
      }
      const { stdin, stdout } = child;
      if (!stdin || !stdout) {
        fail('spawn', 'code extraction child has no stdio pipes');
        return;
      }

      let output = '';
      stdout.setEncoding('utf8');
      stdout.on('data', (chunk: string) => {
        output += chunk;
      });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
      });
      child.on('error', (error: Error) => fail('spawn', `code extraction child failed to start: ${error.message}`));
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail('timeout', `code extraction child did not answer within ${this.timeoutMs} ms`);
      }, this.timeoutMs);

      // The child may exit before its request is written: the pending write then fails with EPIPE.
      // A close is judged only once that write settled, so the failure is reported as `exit`.
      let writeError: Error | undefined;
      const writeSettled = new Promise<void>((settleWrite) => {
        const record = (error?: Error | null): void => {
          if (error) writeError = error;
          settleWrite();
        };
        stdin.on('error', (error: Error) => {
          record(error);
          fail('exit', `code extraction child stopped before its request was written: ${error.message}`);
        });
        stdin.on('close', () => record());
        try {
          stdin.end(JSON.stringify({ files }), (error?: Error | null) => record(error));
        } catch (error) {
          record(error as Error);
          fail('exit', `code extraction request could not be written: ${(error as Error).message}`);
        }
      });

      child.on('close', (code, signal) => {
        void writeSettled.then(() => {
          if (settled) return;
          if (writeError) {
            fail('exit', `code extraction child stopped before its request was written: ${writeError.message}`);
            return;
          }
          if (code !== 0) {
            fail('exit', `code extraction child exited with ${code === null ? signal ?? 'no status' : `code ${code}`}: ${stderr.trim()}`);
            return;
          }
          try {
            const results = parseResponse(output, files.length);
            settle(() => resolve(results));
          } catch (error) {
            fail('protocol', `code extraction child answered outside the protocol: ${(error as Error).message}`);
          }
        });
      });
    });
  }
}
