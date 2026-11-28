import type { CodeGraphService, FileExtraction } from './code-graph.service';

/** One batch of source files to extract symbols from. */
export type ExtractionFile = Readonly<{ path: string; content: string }>;

/**
 * Extracts symbols from a batch of source files.
 *
 * The extraction is asynchronous so a caller can run it outside the api process
 * (`ChildProcessCodeExtractor`) without changing the call site.
 */
export abstract class CodeExtractor {
  abstract extract(files: ReadonlyArray<ExtractionFile>): Promise<FileExtraction[]>;
}

/** Runs the extraction in the api process, through `CodeGraphService`. */
export class InProcessCodeExtractor extends CodeExtractor {
  constructor(private readonly graph: Pick<CodeGraphService, 'extractBatch'>) {
    super();
  }

  async extract(files: ReadonlyArray<ExtractionFile>): Promise<FileExtraction[]> {
    return this.graph.extractBatch(files);
  }
}

export type CodeExtractionFailure = 'spawn' | 'exit' | 'timeout' | 'protocol';

/** A failed batch extraction, classified by the stage that failed. */
export class CodeExtractionError extends Error {
  readonly reason: CodeExtractionFailure;

  constructor(reason: CodeExtractionFailure, message?: string) {
    super(message ?? `code extraction failed: ${reason}`);
    this.name = 'CodeExtractionError';
    this.reason = reason;
  }
}
