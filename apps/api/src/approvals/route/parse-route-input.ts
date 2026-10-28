import { ValidationAppException } from '@nathapp/nestjs-common';

/** Picks the named non-empty string values from an untrusted route-command input. */
export function parseRouteInput<const Names extends readonly string[]>(
  input: unknown,
  names: Names,
): { [Name in Names[number]]: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalidInput();

  const source = input as Record<string, unknown>;
  const parsed: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (typeof value !== 'string' || value.length === 0) throw invalidInput();
    parsed[name] = value;
  }
  return parsed as { [Name in Names[number]]: string };
}

function invalidInput(): ValidationAppException {
  return new ValidationAppException({}, 'approvals.invalidInput');
}
