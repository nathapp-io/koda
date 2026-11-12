export interface MemorySubject {
  type: 'ticket' | 'agent' | 'other'
  /** The part after the `ticket:` / `agent:` prefix; the whole subject for `other`. */
  id: string
  /** `id` cut to its first 8 characters. */
  short: string
}

/** Parse a Memory subject without resolving its identifier against another resource. */
export function memorySubject(subject: string): MemorySubject {
  const separator = subject.indexOf(':')
  const prefix = separator < 0 ? '' : subject.slice(0, separator)
  const id = separator < 0 ? subject : subject.slice(separator + 1)
  if ((prefix === 'ticket' || prefix === 'agent') && id.length > 0) {
    return { type: prefix, id, short: id.slice(0, 8) }
  }
  return { type: 'other', id: subject, short: subject.slice(0, 8) }
}
