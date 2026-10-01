import type { FleetCredential } from '~/lib/fleet-types'

export type ChipTone = 'ok' | 'warn' | 'bad'

/** How nax serves a provider; each code has a label under fleet.runners.chip.kind. */
export const CREDENTIAL_KINDS = ['api-key', 'oauth', 'exec', 'ambient', 'none'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/** One capability chip: an i18n key under fleet.runners.chip, its params, and a tone. */
export interface CapabilityChip {
  id: string
  key: string
  params: Record<string, string>
  tone: ChipTone
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function sandboxChip(raw: unknown): CapabilityChip[] {
  if (!isObj(raw) || typeof raw.available !== 'boolean') return []
  return raw.available
    ? [{ id: 'sandbox', key: 'fleet.runners.chip.sandboxOn', params: {}, tone: 'ok' }]
    : [{ id: 'sandbox', key: 'fleet.runners.chip.sandboxOff', params: {}, tone: 'bad' }]
}

function protocolChips(raw: unknown): CapabilityChip[] {
  if (!isObj(raw) || !Array.isArray(raw.protocols)) return []
  return raw.protocols
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .map((name) => ({ id: `protocol:${name}`, key: 'fleet.runners.chip.protocol', params: { name }, tone: 'ok' as const }))
}

/** How nax serves the provider: the stored kind, else exec, else ambient, else none. */
function credentialKind(c: Pick<FleetCredential, 'stored' | 'exec' | 'ambient'>): CredentialKind {
  if (c.stored) return c.stored.kind
  if (c.exec) return 'exec'
  return c.ambient ? 'ambient' : 'none'
}

function credentialChip(raw: unknown): CapabilityChip[] {
  if (!isObj(raw)) return []
  const provider = str(raw.providerId)
  if (!provider || typeof raw.available !== 'boolean') return []
  const stored = isObj(raw.stored) ? raw.stored : null
  const kind = credentialKind({
    stored: stored && (stored.kind === 'api-key' || stored.kind === 'oauth') ? { kind: stored.kind, expired: stored.expired === true } : null,
    exec: raw.exec === 'served' || raw.exec === 'declined' || raw.exec === 'error' ? raw.exec : undefined,
    ambient: raw.ambient === true,
  })
  const expires = stored ? str(stored.expires) : undefined
  const expired = stored?.expired === true
  const tone: ChipTone = !raw.available ? 'bad' : expired ? 'warn' : 'ok'
  if (!expires) return [{ id: `credential:${provider}`, key: 'fleet.runners.chip.credential', params: { provider, kind }, tone }]
  // An expired credential says so in words, not only by the chip's tone (review 4b).
  const key = expired ? 'fleet.runners.chip.credentialExpired' : 'fleet.runners.chip.credentialExpires'
  return [{ id: `credential:${provider}`, key, params: { provider, kind, expires: expires.slice(0, 10) }, tone }]
}

/**
 * Chips for the Runners table from a runner's `capabilities` (S1 spec §11: sandbox,
 * protocols, credential kinds and expiry). The wire type is an untyped object, so every
 * field is checked; anything malformed yields no chip rather than a crash.
 */
export function capabilityChips(capabilities: unknown): CapabilityChip[] {
  if (!isObj(capabilities)) return []
  const credentials = Array.isArray(capabilities.credentials) ? capabilities.credentials : []
  return [
    ...sandboxChip(capabilities.sandbox),
    ...protocolChips(capabilities.nax),
    ...credentials.flatMap(credentialChip),
  ]
}

/** The nax version the runner reported, or null. */
export function naxVersion(capabilities: unknown): string | null {
  if (!isObj(capabilities) || !isObj(capabilities.nax)) return null
  return str(capabilities.nax.version) ?? null
}
