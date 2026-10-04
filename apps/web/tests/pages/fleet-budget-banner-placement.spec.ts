import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const list = read('pages', '[project]', 'fleet', 'index.vue')
const dispatch = read('pages', '[project]', 'fleet', 'dispatch.vue')
const detail = read('pages', '[project]', 'fleet', 'jobs', '[id]', 'index.vue')

describe('budget banner placement (D179)', () => {
  test.each([
    ['jobs list', list],
    ['dispatch', dispatch],
    ['job detail', detail],
  ])('%s shows the banner for this project with repo names from its options', (_name, source) => {
    expect(source).toContain('<FleetBudgetBanner')
    expect(source).toMatch(/<FleetBudgetBanner[^>]*:slug="slug"[^>]*:repo-name="options\.repoName"/)
  })

  test('the jobs list nudges the banner on every notice, inside the same debounce', () => {
    expect(list).toContain('const banner = ref<{ refresh: () => Promise<void> } | null>(null)')
    expect(list).toMatch(/<FleetBudgetBanner ref="banner"/)
    expect(list).toMatch(/createDebouncer\(\(\) => \{ void reload\(\); void banner\.value\?\.refresh\(\) \}, 300\)/)
  })

  test('the banner sits under the header, above the filters', () => {
    expect(list.indexOf('<FleetBudgetBanner')).toBeGreaterThan(list.indexOf('</PageHeader>'))
    expect(list.indexOf('<FleetBudgetBanner')).toBeLessThan(list.indexOf('fleet-filter-state'))
  })
})

describe('job page budget stop reason (D188)', () => {
  test('a budget:<id> reason renders as text and a link; any other reason renders raw', () => {
    expect(detail).toContain("const budgetPolicyId = computed(() => budgetStopPolicyId(job.value?.stateReason))")
    expect(detail).toMatch(/<template v-if="budgetPolicyId">[\s\S]*?fleet\.jobs\.detail\.budgetStop[\s\S]*?fleet-job-budget-link[\s\S]*?<\/template>\s*<template v-else>\{\{ job\.stateReason \}\}<\/template>/)
    expect(detail).toContain(':title="job.stateReason"')
  })
})
