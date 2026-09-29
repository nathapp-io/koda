/**
 * Tagged template for API paths. Every interpolated value goes through
 * encodeURIComponent, so a slug, ticket ref or id stays one path segment and
 * can never add a segment or a query string. The literal parts are kept as
 * written, so query strings belong in the literal or in `$api`'s `query`.
 *
 *   apiPath`/projects/${slug}/tickets/${ref}`
 *
 * An empty value throws: `/projects//tickets` would reach a different route.
 */
export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  return strings.reduce((path, part, index) => {
    if (index >= values.length) return path + part
    const value = values[index]
    if (value === undefined || value === null || value === '') {
      throw new Error(`apiPath: empty value after "${path + part}"`)
    }
    return path + part + encodeURIComponent(String(value))
  }, '')
}
