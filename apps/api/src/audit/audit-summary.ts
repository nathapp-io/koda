/** Returns sorted field names only; field values are never included. */
export function fieldsSummary(patch: object): string | undefined {
  const fields = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined).sort();
  return fields.length === 0 ? undefined : `fields: ${fields.join(', ')}`;
}
