import { describe, test, expect } from '@jest/globals'
import { KNOWN_PHASES, phaseLabelKey } from '~/lib/fleet-phase'
import enJson from '../../i18n/locales/en.json'
import zhJson from '../../i18n/locales/zh.json'

/** D7: the three nax lists KNOWN_PHASES is built from, spelled out here as the spec spells them out. */
const PIPELINE_STAGES = ['queue-check', 'routing', 'constitution', 'context', 'prompt', 'optimizer', 'execution', 'completion', 'workflow']
const WORKFLOW_PHASES = ['implement', 'gates', 'review', 'rereview', 'suite', 'residual', 'fix', 'closed']
const FEATURE_STEPS = ['repo-gates', 'branch-review', 'branch-fix', 'branch-rereview', 'adjudicate', 'final-gates', 'gate-repair', 'publish', 'done']
const EXPECTED = [...new Set([...PIPELINE_STAGES, ...WORKFLOW_PHASES, ...FEATURE_STEPS])]

const at = (tree: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree)

const label = (locale: Record<string, unknown>, phase: string): unknown => at(locale, `fleet.jobs.phases.${phase}`)

const en = enJson as Record<string, unknown>
const zh = zhJson as Record<string, unknown>

describe('phaseLabelKey (D7)', () => {
  test('AC-1: a known phase maps to its label key', () => {
    expect(phaseLabelKey('branch-review')).toBe('fleet.jobs.phases.branch-review')
  })

  test('AC-2: nax text the web does not know has no key, so it is rendered raw (R4)', () => {
    expect(phaseLabelKey('half-built')).toBeNull()
  })

  test('every known phase maps to fleet.jobs.phases.<phase>', () => {
    for (const phase of KNOWN_PHASES) expect(phaseLabelKey(phase)).toBe(`fleet.jobs.phases.${phase}`)
  })

  test('nax text that resembles a key, an empty string and whitespace stay unknown', () => {
    for (const raw of ['', ' ', 'fleet.jobs.phases.implement', 'IMPLEMENT', '__proto__', 'toString']) {
      expect(phaseLabelKey(raw)).toBeNull()
    }
  })

  test('KNOWN_PHASES is exactly the pipeline stages, the workflow phases and the feature steps, without repeats', () => {
    expect(KNOWN_PHASES.length).toBe(new Set(KNOWN_PHASES).size)
    expect([...KNOWN_PHASES].sort()).toEqual([...EXPECTED].sort())
  })

  test('AC-3: both locales define a non-empty label for every known phase, and no other', () => {
    for (const locale of [en, zh]) {
      const phases = at(locale, 'fleet.jobs.phases')
      expect(phases).toBeDefined()
      expect(Object.keys(phases as Record<string, unknown>).sort()).toEqual([...KNOWN_PHASES].sort())
      for (const phase of KNOWN_PHASES) {
        expect(String(label(locale, phase) ?? '').trim()).not.toBe('')
      }
    }
  })

  test('the en labels are the sentence case of the nax name (D7), with zh alongside', () => {
    expect(label(en, 'branch-review')).toBe('Branch review')
    expect(label(en, 'implement')).toBe('Implement')
    expect(label(en, 'final-gates')).toBe('Final gates')
    expect(label(en, 'queue-check')).toBe('Queue check')
    expect(label(zh, 'branch-review')).not.toBe('Branch review')
  })
})
