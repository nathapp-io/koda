import chalk from 'chalk';
import util from 'util';

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
