import { describe, expect, test } from '@jest/globals'
import {
  costText, dashboardTiles, durationParts, hhmm, jobPath, liveSec, safeHttpUrl, secParts, serverNow, storiesText,
} from '~/lib/fleet-dashboard'

const GEN = '2026-10-05T12:00:00.000Z'
const at = (iso: string): number => Date.parse(iso)

describe('serverNow (D416)', () => {
  test('advances generatedAt by the client time elapsed since the snapshot arrived', () => {
    const received = at('2026-10-05T12:00:01.000Z')
    expect(serverNow(GEN, received, received + 5_000).toISOString()).toBe('2026-10-05T12:00:05.000Z')
  })

  test('a client clock hours away from the server changes nothing (Review Focus 2)', () => {
    const ahead = at('2026-10-05T15:00:00.000Z')
    expect(serverNow(GEN, ahead, ahead + 2_000).toISOString()).toBe('2026-10-05T12:00:02.000Z')
    const behind = at('2026-10-05T09:00:00.000Z')
    expect(serverNow(GEN, behind, behind + 2_000).toISOString()).toBe('2026-10-05T12:00:02.000Z')
  })

  test('a client clock stepping backwards never moves server time before generatedAt', () => {
    const received = at('2026-10-05T12:00:00.000Z')
    expect(serverNow(GEN, received, received - 60_000).toISOString()).toBe(GEN)
  })
})

describe('liveSec and secParts (D416, D417)', () => {
  test('adds the whole seconds since generatedAt to a server-measured age', () => {
    expect(liveSec(190, GEN, new Date('2026-10-05T12:00:10.900Z'))).toBe(200)
  })

  test('never goes below the base, and treats a missing base as 0', () => {
    expect(liveSec(190, GEN, new Date('2026-10-05T11:59:00.000Z'))).toBe(190)
    expect(liveSec(undefined, GEN, new Date('2026-10-05T12:00:30.000Z'))).toBe(30)
    expect(liveSec(-5, GEN, new Date(GEN))).toBe(0)
  })

  test('an unparseable generatedAt keeps the base', () => {
    expect(liveSec(42, 'not a date', new Date(GEN))).toBe(42)
  })

  test('secParts uses the largest whole unit, like ageParts', () => {
    expect(secParts(0)).toEqual({ n: 0, unit: 's' })
    expect(secParts(59)).toEqual({ n: 59, unit: 's' })
    expect(secParts(190)).toEqual({ n: 3, unit: 'm' })
    expect(secParts(7_260)).toEqual({ n: 2, unit: 'h' })
    expect(secParts(200_000)).toEqual({ n: 2, unit: 'd' })
    expect(secParts(-3)).toEqual({ n: 0, unit: 's' })
  })
})

describe('text helpers', () => {
  test('hhmm is the local wall-clock time with two-digit fields', () => {
    expect(hhmm(new Date(2026, 9, 5, 9, 7, 30).getTime())).toBe('09:07')
    expect(hhmm(new Date(2026, 9, 5, 23, 59).getTime())).toBe('23:59')
  })

  test('jobPath is the project job page', () => {
    expect(jobPath('koda', 'job1')).toBe('/koda/fleet/jobs/job1')
  })

  test('storiesText shows done/total, or - when unknown or truncated', () => {
    expect(storiesText(3, 5)).toBe('3/5')
    expect(storiesText(0, 0)).toBe('0/0')
    expect(storiesText(null, 5)).toBe('-')
    expect(storiesText(null, null)).toBe('-')
  })

  test('costText shows the API money unchanged against the cap', () => {
    expect(costText('0.0664', '5.0000')).toBe('$0.0664 / $5.0000')
  })

  test('durationParts measures start to finish, null without a start or with a bad finish', () => {
    expect(durationParts('2026-10-05T11:50:00.000Z', '2026-10-05T12:00:00.000Z')).toEqual({ n: 10, unit: 'm' })
    expect(durationParts(null, GEN)).toBeNull()
    expect(durationParts('2026-10-05T11:50:00.000Z', 'nope')).toBeNull()
  })

  test('safeHttpUrl keeps only http and https URLs (D419)', () => {
    expect(safeHttpUrl('https://github.com/acme/app/pull/1')).toBe('https://github.com/acme/app/pull/1')
    expect(safeHttpUrl('http://gitlab.local/a/b/-/merge_requests/2')).toBe('http://gitlab.local/a/b/-/merge_requests/2')
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('not a url')).toBeNull()
    expect(safeHttpUrl(null)).toBeNull()
  })
})

describe('dashboardTiles (D423)', () => {
  test('four tiles linking to their sections, with tones from the counts', () => {
    expect(dashboardTiles({ runnersOnline: 1, runnersTotal: 2, queued: 3, running: 4, attention: 2 })).toEqual([
      { id: 'runners', value: '1/2', href: '#fleet-dashboard-runners', tone: 'warn' },
      { id: 'queued', value: '3', href: '#fleet-dashboard-active', tone: 'ok' },
      { id: 'running', value: '4', href: '#fleet-dashboard-active', tone: 'ok' },
      { id: 'attention', value: '2', href: '#fleet-dashboard-attention', tone: 'bad' },
    ])
  })

  test('an empty fleet reads 0/0 and every tone is ok (Review Focus 5)', () => {
    expect(dashboardTiles({ runnersOnline: 0, runnersTotal: 0, queued: 0, running: 0, attention: 0 }).map((t) => [t.value, t.tone]))
      .toEqual([['0/0', 'ok'], ['0', 'ok'], ['0', 'ok'], ['0', 'ok']])
  })
})
