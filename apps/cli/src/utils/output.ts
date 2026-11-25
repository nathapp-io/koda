import chalk from 'chalk';
import util from 'util';
import { Console } from 'node:console';
import { fstat, writeSync } from 'node:fs';
import { Writable } from 'node:stream';

const statDescriptor = util.promisify(fstat);

function failOutput(reason: unknown): never {
  console.error('Failed to write CLI output:', reason instanceof Error ? reason.message : String(reason));
  return process.exit(1);
}

/** Install once at the executable entry point, before commands print their first result. */
export async function configureResultOutput(): Promise<void> {
  const stdout = process.stdout;
  // Node can clear stdout.errored after EPIPE while a log command awaits its next page.
  stdout.on('error', failOutput);
  if (stdout.isTTY || !(await statDescriptor(stdout.fd)).isFile()) return;

  // The default regular-file stdout writer ignores short write counts. Keep file output
  // synchronous (including on nonzero exit paths) and let Console format each line.
  const file = new Writable({
    write(bytes: Buffer, _encoding, done) {
      try {
        const written = writeSync(stdout.fd, bytes);
        if (written !== bytes.length) return failOutput(`wrote ${written} of ${bytes.length} bytes`);
      } catch (error) {
        return failOutput(error);
      }
      done();
    },
  });
  console.log = new Console(file, process.stderr).log;
}

/** Finish a successful action only after stdout has accepted its entire result. */
export function finishSuccess(): void {
  const stdout = process.stdout;
  if (stdout.errored || stdout.destroyed) {
    return failOutput(stdout.errored ?? 'stdout is closed');
  }
  if (stdout.writableLength === 0) {
    return process.exit(0);
  }

  // This callback is ordered after pending writes and adds no bytes to the result.
  stdout.write('', (err) => {
    if (err) return failOutput(err);
    return process.exit(0);
  });
}

interface OutputOptions {
  json?: boolean;
}

/**
 * Output data in JSON or pretty-printed format.
 * JSON mode: outputs valid JSON to stdout
 * Pretty mode: outputs formatted representation to stdout
 */
export function output(data: unknown, options: OutputOptions = {}): void {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(util.inspect(data, { colors: true, depth: null }));
  }
}

/**
 * Render a column-aligned table with cyan/bold headers.
 * Headers are colored; rows are plain text.
 */
export function table(headers: string[], rows: string[][]): void {
  if (headers.length === 0) {
    return;
  }

  // Calculate column widths based on headers and rows
  const columnWidths = headers.map((header, i) => {
    let maxWidth = header.length;
    for (const row of rows) {
      if (row[i]) {
        maxWidth = Math.max(maxWidth, row[i].length);
      }
    }
    return maxWidth;
  });

  // Print header row with cyan bold
  const headerRow = headers
    .map((header, i) => header.padEnd(columnWidths[i]))
    .join('  ');
  console.log(chalk.cyan.bold(headerRow));

  // Print separator
  const separator = columnWidths
    .map((width) => '─'.repeat(width))
    .join('  ');
  console.log(chalk.gray(separator));

  // Print data rows
  for (const row of rows) {
    const paddedRow = row
      .map((cell, i) => (cell || '').padEnd(columnWidths[i]))
      .join('  ');
    console.log(paddedRow);
  }
}

/**
 * Print a success message in green to stdout.
 */
export function success(message: string): void {
  console.log(chalk.green(`✓ ${message}`));
}

/**
 * Print an error message in red to stderr.
 */
export function error(message: string): void {
  console.error(chalk.red(`✗ ${message}`));
}

/**
 * Print a warning message in yellow to stderr.
 */
export function warn(message: string): void {
  console.error(chalk.yellow(`⚠ ${message}`));
}
