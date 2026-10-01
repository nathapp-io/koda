export type Translate = (key: string) => string
export type HasKey = (key: string) => boolean

/** D126: the translation of a server code under `prefix`, or the raw code when no key exists. */
export function codeLabel(t: Translate, te: HasKey, prefix: string, code: string): string {
  const key = `${prefix}.${code}`
  return te(key) ? t(key) : code
}
