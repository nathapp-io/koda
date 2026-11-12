import { describe, expect, test } from '@jest/globals'
import { formatDateTime } from '~/lib/format-date-time'
import { jobFixture, mountEnginePage } from './fleet-job-detail.spec'

describe('fleet job detail field visibility (US-005)', () => {
  test('AC-3/4 shows a missing heartbeat dash immediately and local queued time after mount', async () => {
    const queuedAt = '2026-11-10T14:07:45.657Z'
    const page = mountEnginePage({ job: jobFixture({ state: 'RUNNING', queuedAt, lastHeartbeatAt: null }), records: [] })
    await page.settle()
    const text = page.app.text()
    expect(text).toContain('Last heartbeat')
    expect(text).toContain('Queued')
    expect(text).toContain(formatDateTime(queuedAt, 'en'))
    const labels = page.app.find('dt')
    const heartbeatLabel = labels.find((node) => page.app.textOf(node) === 'Last heartbeat')
    expect(heartbeatLabel).toBeDefined()
    if (heartbeatLabel?.parent === null || heartbeatLabel?.parent === undefined) throw new Error('heartbeat label has no details list')
    const heartbeatIndex = heartbeatLabel.parent.children.indexOf(heartbeatLabel)
    const heartbeatValue = heartbeatLabel.parent.children[heartbeatIndex + 1]
    if (heartbeatValue === undefined) throw new Error('heartbeat value is missing')
    expect(page.app.textOf(heartbeatValue)).toBe('-')
    const queuedLabel = labels.find((node) => page.app.textOf(node) === 'Queued')
    if (queuedLabel?.parent === null || queuedLabel?.parent === undefined) throw new Error('queued label has no details list')
    const queuedIndex = queuedLabel.parent.children.indexOf(queuedLabel)
    const queuedValue = queuedLabel.parent.children[queuedIndex + 1]
    if (queuedValue === undefined) throw new Error('queued value is missing')
    expect(page.app.textOf(queuedValue)).toBe(formatDateTime(queuedAt, 'en'))
    page.app.unmount()
  })

  const mount = async (over: Parameters<typeof jobFixture>[0] = {}) => {
    const page = mountEnginePage({ job: jobFixture(over), records: [] })
    await page.settle()
    return page
  }

  test('AC-4: completed jobs hide Last heartbeat despite a timestamp', async () => {
    const page = await mount({ state: 'COMPLETED', lastHeartbeatAt: '2026-01-02T03:04:05.000Z' })
    expect(page.app.text()).not.toContain('Last heartbeat')
    page.app.unmount()
  })

  test('AC-5: running jobs show Last heartbeat', async () => {
    const page = await mount({ state: 'RUNNING', lastHeartbeatAt: '2026-01-02T03:04:05.000Z' })
    expect(page.app.text()).toContain('Last heartbeat')
    page.app.unmount()
  })

  test('AC-6 and AC-7: hides empty metadata but retains required fields', async () => {
    const page = await mount({ state: 'COMPLETED', profiles: [], finishResult: null, resultBranch: null, resultPrUrl: null, startedAt: null })
    const text = page.app.text()
    for (const label of ['Profile chain', 'Finish result', 'Branch', 'Pull request', 'Started']) {
      expect(text).not.toContain(label)
    }
    for (const label of ['Runner', 'Requested by', 'Queued']) {
      expect(text).toContain(label)
    }
    page.app.unmount()
  })

  test('AC-8: renders populated finish result and branch', async () => {
    const page = await mount({ state: 'COMPLETED', finishResult: 'promoted', resultBranch: 'feat/x' })
    expect(page.app.text()).toContain('Finish result')
    expect(page.app.text()).toContain('promoted')
    expect(page.app.text()).toContain('Branch')
    expect(page.app.text()).toContain('feat/x')
    page.app.unmount()
  })

  test('AC-9: cancelled RUN shows failed WIP push status on the Branch item', async () => {
    const page = await mount({ state: 'CANCELLED', command: 'RUN', resultBranch: null, wipPush: 'failed:auth' })
    expect(page.app.text()).toContain('Branch')
    expect(page.app.text()).toContain('Progress push failed: auth')
    page.app.unmount()
  })
})
