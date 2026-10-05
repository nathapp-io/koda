import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { webFile } from '../helpers/mount-sfc'

const read = (name: string): string => readFileSync(webFile('components', 'fleet', 'analytics', name), 'utf-8')

describe('chart components (D389, D398, spec §5.5)', () => {
  const area = read('SpendAreaChart.client.vue')
  const line = read('RateLineChart.client.vue')

  it('are client-only unovis wrappers with an accessible summary', () => {
    for (const source of [area, line]) {
      expect(source).toContain("from '@unovis/vue'")
      expect(source).toContain('role="img"')
      expect(source).toContain(':aria-label="label"')
      expect(source).not.toContain('v-html')
    }
  })

  it('build every tooltip through the escaping helpers, never from raw labels', () => {
    expect(area).toContain('crosshairHtml(d, props.series, props.bucket)')
    expect(line).toContain('rateHtml(d, props.bucket, props.seriesLabel)')
  })

  it('stack one area per series in its slot color and pin the rate axis to 0..1', () => {
    expect(area).toContain('<VisArea :x="x" :y="y" :color="color" />')
    expect(area).toContain("props.series[i]?.color ?? 'var(--chart-other)'")
    expect(line).toContain(':y-domain="[0, 1]"')
  })
})
