import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import * as ts from 'typescript'
import { compileScript, parse } from 'vue/compiler-sfc'
import { readFileSync } from 'fs'
import { webFile } from '../helpers/mount-sfc'
import { i18nStub } from '../helpers/fleet-harness'
import { globalPermissionsStub } from '../helpers/permission-nav'

const layoutPath = webFile('layouts', 'default.vue')
const layoutSource = readFileSync(layoutPath, 'utf-8')
interface Crumb { label: string; to?: string }

function breadcrumbItemsFor(path: string, params: Record<string, string>): Crumb[] {
  const script = compileScript(parse(layoutSource, { filename: layoutPath }).descriptor, { id: 'breadcrumb-leaves-test' }).content
  const js = ts.transpileModule(script.replace(/\bimport\.meta\.server\b/g, 'false').replace(/\bimport\.meta\.client\b/g, 'true'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const auto = {
    ref: Vue.ref, computed: Vue.computed, watch: () => undefined, onMounted: () => undefined, onBeforeUnmount: () => undefined,
    nextTick: (fn?: () => unknown) => { if (fn) fn() }, useI18n: () => i18nStub(),
    useAuth: () => ({ user: { value: { email: 'a@k.t', role: 'MEMBER' } }, logout: () => undefined }),
    useRoute: () => ({ path, params }), useGlobalPermissions: () => globalPermissionsStub(),
  }
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  new Function('require', 'module', 'exports', '__auto', 'const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useI18n, useAuth, useRoute, useGlobalPermissions } = __auto;\n' + js)(
    (id: string) => id === 'lucide-vue-next' ? {} : require(id), mod, mod.exports, auto,
  )
  const component = mod.exports.default as { setup: (props: unknown, ctx: unknown) => Record<string, unknown> }
  const bindings = component.setup({}, { expose: () => undefined, attrs: {}, slots: {}, emit: () => undefined })
  return (bindings.breadcrumbItems as { value: Crumb[] }).value
}

describe('default layout project breadcrumb leaves', () => {
  test.each([
    ['/web/timeline', 'nav.timeline'],
    ['/web/memory', 'nav.memory'],
    ['/web/code-intel', 'nav.codeIntel'],
    ['/web/settings', 'nav.settings'],
    ['/web/approvals', 'nav.approvals'],
    ['/web/approval-policies', 'nav.approvalPolicies'],
  ])('adds the correct leaf for %s', (path, leaf) => {
    expect(breadcrumbItemsFor(path, { project: 'web' })).toEqual([
      { label: 'Koda', to: '/' }, { label: 'web', to: '/web' }, { label: leaf },
    ])
  })

  test('preserves flows and project root breadcrumbs', () => {
    expect(breadcrumbItemsFor('/web/flows', { project: 'web' })).toEqual([
      { label: 'Koda', to: '/' }, { label: 'web', to: '/web' }, { label: 'nav.flows' },
    ])
    expect(breadcrumbItemsFor('/web', { project: 'web' })).toEqual([
      { label: 'Koda', to: '/' }, { label: 'web' },
    ])
  })
})
