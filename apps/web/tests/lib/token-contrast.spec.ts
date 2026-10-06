import { readFileSync } from 'fs'
import { join } from 'path'

type Rgb = [number, number, number]

function hslToRgb(h: number, s: number, l: number): Rgb {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

function luminance(rgb: Rgb): number {
  const chan = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2])
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = luminance(a) >= luminance(b) ? [a, b] : [b, a]
  return (luminance(hi) + 0.05) / (luminance(lo) + 0.05)
}

function parseBlock(css: string, selector: string): Record<string, string> {
  const m = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\}`))
  if (!m) throw new Error(`block ${selector} not found`)
  const tokens: Record<string, string> = {}
  for (const mm of m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[mm[1]] = mm[2].trim()
  return tokens
}

function tokenRgb(tokens: Record<string, string>, name: string): Rgb {
  const raw = tokens[name]
  if (!raw) throw new Error(`token --${name} not found`)
  if (raw.startsWith('#')) {
    const h = raw.slice(1)
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
  }
  const [h, s, l] = raw.split(/\s+/).map((x) => parseFloat(x))
  return hslToRgb(h, s, l)
}

const css = readFileSync(join(__dirname, '../../assets/css/globals.css'), 'utf8')
const themes = { light: parseBlock(css, ':root'), dark: parseBlock(css, '\\.dark') }

// Pairs the components actually render: filled colors with their foreground, and
// text colors on the surfaces they sit on (background/card). WCAG AA normal text = 4.5.
const PAIRS: Array<[string, string]> = [
  ['background', 'foreground'],
  ['card', 'card-foreground'],
  ['popover', 'popover-foreground'],
  ['muted', 'muted-foreground'],
  ['secondary', 'secondary-foreground'],
  ['accent', 'accent-foreground'],
  ['primary', 'primary-foreground'],
  ['destructive', 'destructive-foreground'],
  ['background', 'muted-foreground'],
  ['card', 'muted-foreground'],
  ['background', 'status-rejected'],
  ['card', 'status-rejected'],
]

describe('design token contrast (WCAG AA)', () => {
  test.each(Object.entries(themes))('%s theme: every text pair is at least 4.5:1', (_name, tokens) => {
    const failures = PAIRS.filter(([bg, fg]) => contrast(tokenRgb(tokens, bg), tokenRgb(tokens, fg)) < 4.5)
    const report = failures.map(
      ([bg, fg]) => `${fg} on ${bg}: ${contrast(tokenRgb(tokens, bg), tokenRgb(tokens, fg)).toFixed(2)}`,
    )
    expect(report).toEqual([])
  })
})

// `--destructive` in dark mode is a fill color: white text on it passes (6.7:1) but
// it as *text* on a dark card is 2.68:1. Text usages must use `text-status-rejected`
// (the dark-stepped red). Filled pairs (bg-destructive + text-destructive-foreground)
// are exempt — that is the pair the contrast table above already pins.
const FILL_CONTEXT_FILES = [
  'components/ui/button/Button.vue',
  'components/ui/badge/Badge.vue',
  'components/fleet/ApprovalBadge.vue',
]

describe('destructive text usage', () => {
  test('text-destructive is only used inside filled destructive contexts', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('child_process') as typeof import('child_process')
    const root = join(__dirname, '../../')
    const files = execSync(
      `grep -rln "text-destructive" ${root}components ${root}pages ${root}layouts || true`,
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean)
    const bareClass = /(^|[\s'"`])text-destructive(?![-\w])/
    const hits = files.filter((f: string) => bareClass.test(readFileSync(f, 'utf8')))
    const offenders = hits.filter((f: string) => {
      const rel = f.replace(root, '')
      return !FILL_CONTEXT_FILES.includes(rel)
    })
    expect(offenders).toEqual([])
  })
})
