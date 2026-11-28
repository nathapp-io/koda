import type { CodeGraphService, FileExtraction } from './code-graph.service';

/** One source file on the wire, from the api process to the extraction child. */
export interface ExtractionRequestFile {
  path: string;
  content: string;
}

/** The extraction child's answer: one result per request file, in request order. */
export interface ExtractionResponse {
  results: FileExtraction[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRequestFile(value: unknown): value is ExtractionRequestFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { path?: unknown; content?: unknown };
  return typeof candidate.path === 'string' && typeof candidate.content === 'string';
}

function readRequestFiles(input: string): ExtractionRequestFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`extraction request is not JSON: ${describe(error)}`);
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) throw new Error('extraction request has no files array');
  if (!files.every(isRequestFile)) {
    throw new Error('extraction request files must each carry a string path and content');
  }
  return files;
}

/**
 * The extraction child's logic: parse the request, extract every file, answer with the batch.
 * Pure so the child entry script stays a thin stdin/stdout shell.
 */
export function runExtractionRequest(input: string, graph: Pick<CodeGraphService, 'extractBatch'>): string {
  const files = readRequestFiles(input);
  const response: ExtractionResponse = { results: graph.extractBatch(files) };
  return JSON.stringify(response);
}
