import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(__dirname, '../../../../../..');

export function readWorkflow(file: string): string {
  return readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8');
}

/**
 * The `run: |` body of the workflow step that contains the given `id:` or `name:` line. A step is the YAML list
 * item that starts at its `      - ` line and ends at the next sibling item or a dedent to job level. The body is
 * the indented block after `run: |` with its common indentation removed, so it runs as GitHub runs it.
 */
export function stepBody(workflow: string, identity: string): string {
  const lines = workflow.split('\n');
  let stepStart = -1;
  let stepEnd = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('      - ')) continue;
    let end = index + 1;
    while (end < lines.length && !/^      - /.test(lines[end]) && !/^    [^ ]/.test(lines[end])) end += 1;
    if (lines.slice(index, end).some((line) => line.trim() === identity)) {
      stepStart = index;
      stepEnd = end;
      break;
    }
  }
  if (stepStart < 0) throw new Error(`Workflow step ${identity} not found`);
  const runIndex = lines.findIndex((line, index) => index > stepStart && index < stepEnd && /^        run: \|$/.test(line));
  if (runIndex < 0) throw new Error(`Run body not found for ${identity}`);
  const bodyLines: string[] = [];
  for (let index = runIndex + 1; index < stepEnd; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.startsWith('          ')) break;
    bodyLines.push(line.startsWith('          ') ? line.slice(10) : '');
  }
  return bodyLines.join('\n').replace(/^\n+|\n+$/g, '');
}

/** The text of one job, from its `  <name>:` line up to the next job. */
export function jobBlock(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start < 0) throw new Error(`Workflow job ${job} not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
