export interface OutputOptions {
  json?: boolean;
}

export function output(data: unknown, options?: OutputOptions): void {
  if (options?.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

export function table(headers: string[], rows: string[][]): void {
  const headerRow = headers.join('  ');
  console.log(headerRow);

  rows.forEach((row) => {
    console.log(row.join('  '));
  });
}

export function success(message: string): void {
  console.log(message);
}

export function error(message: string): void {
  console.error(message);
}

export function warn(message: string): void {
  console.warn(message);
}
