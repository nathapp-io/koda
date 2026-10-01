import { describe, expect, it } from '@jest/globals'
import { CREDENTIAL_KINDS, capabilityChips, naxVersion } from '~/lib/fleet-capabilities'

const caps = {
  nax: { version: '0.83.1', protocols: ['native', 'acp'] },
  sandbox: { available: true, probedAt: '2026-10-01T00:00:00Z' },
  profiles: {},
  credentials: [
    { providerId: 'anthropic', available: true, stored: { kind: 'oauth', expires: '2026-11-02T10:00:00Z', expired: false }, ambient: false },
    { providerId: 'openai', available: true, stored: { kind: 'api-key', expired: false }, ambient: false },
    { providerId: 'zai', available: true, stored: { kind: 'oauth', expires: '2026-09-30T00:00:00Z', expired: true }, ambient: false },
    { providerId: 'minimax', available: false, stored: null, exec: 'declined', ambient: false },
    { providerId: 'bedrock', available: true, stored: null, ambient: true },
    { providerId: 'none', available: false, stored: null, ambient: false },
  ],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
}

describe('capabilityChips', () => {
  it('lists sandbox, protocols, then one chip per credential with kind, expiry and tone', () => {
    expect(capabilityChips(caps)).toEqual([
      { id: 'sandbox', key: 'fleet.runners.chip.sandboxOn', params: {}, tone: 'ok' },
      { id: 'protocol:native', key: 'fleet.runners.chip.protocol', params: { name: 'native' }, tone: 'ok' },
      { id: 'protocol:acp', key: 'fleet.runners.chip.protocol', params: { name: 'acp' }, tone: 'ok' },
      { id: 'credential:anthropic', key: 'fleet.runners.chip.credentialExpires', params: { provider: 'anthropic', kind: 'oauth', expires: '2026-11-02' }, tone: 'ok' },
      { id: 'credential:openai', key: 'fleet.runners.chip.credential', params: { provider: 'openai', kind: 'api-key' }, tone: 'ok' },
      { id: 'credential:zai', key: 'fleet.runners.chip.credentialExpired', params: { provider: 'zai', kind: 'oauth', expires: '2026-09-30' }, tone: 'warn' },
      { id: 'credential:minimax', key: 'fleet.runners.chip.credential', params: { provider: 'minimax', kind: 'exec' }, tone: 'bad' },
      { id: 'credential:bedrock', key: 'fleet.runners.chip.credential', params: { provider: 'bedrock', kind: 'ambient' }, tone: 'ok' },
      { id: 'credential:none', key: 'fleet.runners.chip.credential', params: { provider: 'none', kind: 'none' }, tone: 'bad' },
    ])
  })

  it('shows an unavailable sandbox as a bad chip', () => {
    expect(capabilityChips({ ...caps, nax: undefined, credentials: [], sandbox: { available: false, probedAt: 'x', error: 'bwrap missing' } }))
      .toEqual([{ id: 'sandbox', key: 'fleet.runners.chip.sandboxOff', params: {}, tone: 'bad' }])
  })

  it('never throws on a malformed report: bad parts yield no chip', () => {
    expect(capabilityChips(null)).toEqual([])
    expect(capabilityChips('x')).toEqual([])
    expect(capabilityChips({})).toEqual([])
    expect(capabilityChips({ sandbox: { available: 'yes' }, nax: { protocols: [1, ''] }, credentials: [null, { providerId: 'p' }, 'x'] })).toEqual([])
  })
})

describe('naxVersion', () => {
  it('reads nax.version or null', () => {
    expect(naxVersion(caps)).toBe('0.83.1')
    expect(naxVersion({})).toBeNull()
    expect(naxVersion({ nax: { version: 3 } })).toBeNull()
  })
})

describe('every chip key exists in both locales', () => {
  const en = require('../../i18n/locales/en.json') as Record<string, unknown>
  const zh = require('../../i18n/locales/zh.json') as Record<string, unknown>
  const has = (tree: Record<string, unknown>, key: string) =>
    typeof key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree) === 'string'

  it.each([['en', en], ['zh', zh]])('%s', (_name, tree) => {
    const keys = new Set([
      ...capabilityChips(caps).map((chip) => chip.key),
      ...capabilityChips({ sandbox: { available: false } }).map((chip) => chip.key),
      // The chips component translates params.kind through fleet.runners.chip.kind.<code>.
      ...CREDENTIAL_KINDS.map((kind) => `fleet.runners.chip.kind.${kind}`),
    ])
    expect([...keys].filter((key) => !has(tree as Record<string, unknown>, key))).toEqual([])
  })

  it('every kind a chip can carry is in CREDENTIAL_KINDS', () => {
    const kinds = capabilityChips(caps).flatMap((chip) => (chip.params.kind ? [chip.params.kind] : []))
    expect(kinds.filter((kind) => !(CREDENTIAL_KINDS as readonly string[]).includes(kind))).toEqual([])
  })
})
