/**
 * C10 US-012: the provider-credential form rules, mirrored for the browser.
 *
 * The web has no generated API client, so it cannot import `apps/api/src/fleet/provider-credentials/
 * provider-credential.domain.ts`. These constants are that file's numbers and patterns, and the
 * schemas are the ones a management form validates with — the API validates again, so a mismatch can
 * only ever refuse a write twice, never accept a bad one.
 */
import * as z from 'zod'

/** `PROVIDER_ID_PATTERN`: lowercase, 1-48 chars, dots/dashes/underscores after the first. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/

export const PROVIDER_CREDENTIAL_NAME_MAX_LENGTH = 64

/** 16 keeps `last4` to at most a quarter of the key; 8192 is the nax helper contract's ceiling. */
export const PROVIDER_CREDENTIAL_KEY_MIN_LENGTH = 16
export const PROVIDER_CREDENTIAL_KEY_MAX_LENGTH = 8192
export const NO_WHITESPACE_PATTERN = /^\S+$/

/** What the schemas need from `useI18n()`: a translated message for a key. */
export type Translate = (key: string) => string

/** The key field's rules: 16-8192 characters, no whitespace. Reused by rotate (US-012) and the card (US-013). */
export function providerKeySchema(t: Translate) {
  return z.string()
    .min(PROVIDER_CREDENTIAL_KEY_MIN_LENGTH, t('fleet.providerKeys.validation.keyLength'))
    .max(PROVIDER_CREDENTIAL_KEY_MAX_LENGTH, t('fleet.providerKeys.validation.keyLength'))
    .regex(NO_WHITESPACE_PATTERN, t('fleet.providerKeys.validation.keyWhitespace'))
}

/** The display name's rules: 1-64 characters. */
export function providerCredentialNameSchema(t: Translate) {
  return z.string()
    .min(1, t('fleet.providerKeys.validation.nameLength'))
    .max(PROVIDER_CREDENTIAL_NAME_MAX_LENGTH, t('fleet.providerKeys.validation.nameLength'))
}

/** The add form: provider id, display name and the key (write-only). */
export function providerCredentialFormSchema(t: Translate) {
  return z.object({
    providerId: z.string().regex(PROVIDER_ID_PATTERN, t('fleet.providerKeys.validation.providerId')),
    name: providerCredentialNameSchema(t),
    key: providerKeySchema(t),
  })
}
