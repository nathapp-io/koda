/**
 * Mounts a real .vue file in node without a DOM: compiles the SFC with vue/compiler-sfc, transpiles
 * its TypeScript, and renders it through a minimal custom renderer that records element props and
 * event handlers. Enough to fire a native event at an element and observe what the component emits,
 * which is what makes behavioural (not source-grep) page/dialog tests possible.
 *
 * `~/…` imports resolve to real files under apps/web; bare specifiers resolve through node require, so
 * a component keeps exercising its real helpers (zod, vee-validate). Nuxt auto-imports are NOT
 * compiled in: pass them through `globals`, and use `alias` to replace a module node cannot require.
 *
 * Only the compiled source is cached; each mount re-instantiates the module, so per-mount state
 * (and the globals it was given) never leak into the next test.
 */
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import * as ts from 'typescript'
import * as Vue from 'vue'
import type { Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

const webRoot = join(__dirname, '..', '..')
const nodeRequire = createRequire(join(webRoot, 'package.json'))

export interface FakeNode {
  tag: string
  props: Record<string, unknown>
  children: FakeNode[]
  text: string
  parent: FakeNode | null
}

export interface MountOptions {
  props?: Record<string, unknown>
  /** Nuxt auto-imports the SFC uses without importing (ref, useI18n, useAppToast, …). */
  globals?: Record<string, unknown>
  /** Component-name stubs, e.g. { Badge: { template: '<i><slot/>' } }. */
  components?: Record<string, unknown>
  /**
   * Real `components/fleet/*.vue` to register under their Nuxt auto-import names, so a test mounts
   * the actual component instead of a stub whose placeholder it then asserts on.
   */
  fleetComponents?: readonly FleetComponentName[]
  /** specifier → module, for packages node cannot require (an ESM-only icon package, say). */
  alias?: Record<string, unknown>
}

export interface Mounted {
  root: FakeNode
  /**
   * Every node matching a selector, optionally scoped to `scope`. A selector is a tag name (`tr`), an
   * attribute selector (`[data-stub="tr"]`), or a direct-child chain (`a > b`). Stubs share a single
   * element tag, so tests identify them by attribute.
   */
  find: (selector: string, scope?: FakeNode) => FakeNode[]
  /** First match, or undefined — for single-element assertions. */
  one: (selector: string) => FakeNode | undefined
  /** Concatenated text of the whole tree, comments stripped. */
  text: () => string
  /** All text under one node — how a test identifies a button by its label. */
  textOf: (found: FakeNode) => string
  /** Args of every emit the component fired, in order; filtered by name when given. */
  emitted: (name?: string) => unknown[][]
  unmount: () => void
}

const node = (tag: string, text = ''): FakeNode => ({ tag, props: {}, children: [], text, parent: null })

/**
 * All the text under `n`, comments excluded. A node's own `text` is only set by `setText`, so an
 * element's label lives in its descendants — this is what "does this button say Edit?" needs.
 */
export function textOf(n: FakeNode): string {
  const parts: string[] = []
  const visit = (node: FakeNode): void => {
    if (node.tag === '#comment') return
    // Only a text node carries copy; an element's own `text` is empty unless setElementText filled it.
    if (node.tag === '#text') parts.push(node.text)
    node.children.forEach(visit)
  }
  visit(n)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

const renderer = Vue.createRenderer({
  createElement: (tag: string) => node(tag),
  createText: (text: string) => node('#text', text),
  createComment: (text: string) => node('#comment', text),
  setText: (n: FakeNode, text: string) => { n.text = text },
  setElementText: (n: FakeNode, text: string) => { n.children = [node('#text', text)] },
  insert: (child: FakeNode, parent: FakeNode, anchor: FakeNode | null) => {
    child.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    parent.children = at < 0 ? [...parent.children, child] : [...parent.children.slice(0, at), child, ...parent.children.slice(at)]
  },
  remove: (child: FakeNode) => {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child)
  },
  patchProp: (el: FakeNode, key: string, _prev: unknown, next: unknown) => { el.props = { ...el.props, [key]: next } },
  parentNode: (n: FakeNode) => n.parent,
  nextSibling: (n: FakeNode) => {
    if (!n.parent) return null
    return n.parent.children[n.parent.children.indexOf(n) + 1] ?? null
  },
})

/**
 * Vue's reactivity helpers, injected from the real `vue` so a mounted component shares one runtime.
 * The rest are Nuxt auto-imports a test supplies per mount.
 */
const VUE_HELPERS = ['ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount', 'onUnmounted', 'nextTick', 'useId'] as const

/** Nuxt auto-import names injected as undefined unless the test supplies them (see MountOptions.globals). */
const NUXT_AUTO_IMPORTS = [
  'useI18n', 'useAppToast', 'useApi', 'useRuntimeConfig', 'definePageMeta',
  'useVisiblePolling', 'useFleetRunners', 'useFleetRepos', 'useRoute', 'useRouter',
  'useFleetDispatchOptions', 'useFleetJobs', 'useProjectViewerRole',
  'useAdminUsers', 'useProjectEvents', 'useAuth', 'useProjectMemberNames', 'useFleetJobLogs',
] as const

/** Defaults for auto-imports a test did not supply; `definePageMeta` is a compile-time no-op macro. */
const AUTO_IMPORT_DEFAULTS: Record<string, unknown> = { definePageMeta: () => undefined }

/** Compiled JS per file: the expensive half, safe to reuse across mounts. */
const sourceCache = new Map<string, string>()

function transpile(source: string, file: string): string {
  // Nuxt/Vite-only syntax that `new Function` cannot parse. The harness renders on the client, so
  // `import.meta.server` is false and `import.meta.client` is true (see useApi.ts's base-URL branch).
  const runnable = source
    .replace(/\bimport\.meta\.server\b/g, 'false')
    .replace(/\bimport\.meta\.client\b/g, 'true')
  return ts.transpileModule(runnable, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
}

function compileFile(file: string): string {
  const cached = sourceCache.get(file)
  if (cached !== undefined) return cached
  const js = file.endsWith('.vue')
    ? transpile(compileScript(parse(readFileSync(file, 'utf-8'), { filename: file }).descriptor, { id: 'test', inlineTemplate: true }).content, file)
    : transpile(readFileSync(file, 'utf-8'), file)
  sourceCache.set(file, js)
  return js
}

/** Instantiates one module: its own scope, its own module state, the caller's globals. */
function instantiate(file: string, globals: Record<string, unknown>, alias: Record<string, unknown>): Record<string, unknown> {
  const localRequire = (id: string): unknown => {
    if (id in alias) return alias[id]
    if (id === 'vue') return Vue
    if (id.startsWith('~/') || id.startsWith('@/')) {
      const base = join(webRoot, id.slice(2))
      for (const candidate of [base, `${base}.ts`, `${base}.vue`, join(base, 'index.ts')]) {
        if (!exists(candidate)) continue
        return instantiate(candidate, globals, alias)
      }
      throw new Error(`mount-sfc: cannot resolve ${id} from ${file}`)
    }
    return nodeRequire(id)
  }
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  // Auto-imports are destructured onto the module scope, but only the ones this module does not
  // itself declare: `composables/useApi.ts` defines and exports `useApi`, so injecting it again
  // would be a redeclaration. Skipping it is safe — the module's own binding is the real one.
  const js = compileFile(file)
  const bindings: Record<string, unknown> = {
    ...Object.fromEntries(VUE_HELPERS.map((name) => [name, (Vue as unknown as Record<string, unknown>)[name]])),
    ...Object.fromEntries(NUXT_AUTO_IMPORTS.map((name) => [name, AUTO_IMPORT_DEFAULTS[name]])),
    ...globals,
  }
  const injected = [...VUE_HELPERS, ...NUXT_AUTO_IMPORTS].filter((name) => !declaresTopLevel(js, name))
  const prelude = `const { ${injected.join(', ')} } = __auto;\n`
  new Function('require', 'module', 'exports', '__auto', prelude + js)(
    localRequire, mod, mod.exports, Object.fromEntries(injected.map((name) => [name, bindings[name]])),
  )
  return mod.exports
}

/** True when the compiled module declares `name` at top level (so injecting it would collide). */
function declaresTopLevel(js: string, name: string): boolean {
  return new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var|function|class)\\s+${name}\\b`).test(js)
}

function exists(file: string): boolean {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * Records the component's own emits. Handlers must reach it as *vnode props* (which is where Vue's
 * `emit()` looks), so they are injected by a wrapper rather than by declaring them as props.
 */
function withEmitRecorder(inner: Component, record: (name: string, args: unknown[]) => void): Component {
  const declared = (inner as { emits?: string[] | Record<string, unknown> }).emits
  const names = Array.isArray(declared) ? declared : Object.keys(declared ?? {})
  return {
    name: 'EmitRecorder',
    // Without this, Vue's attr fallthrough clones the component root vnode and mergeProps
    // concatenates the recorded listener with the raw one (onDecide -> [record, raw]), so every
    // emit reached the root prop handler twice. The render below forwards attrs explicitly.
    inheritAttrs: false,
    setup(_props: unknown, { attrs }: { attrs: Record<string, unknown> }) {
      const listeners: Record<string, unknown> = {}
      for (const name of names) {
        const onEvent = `on${String(name)[0]?.toUpperCase()}${String(name).slice(1)}`
        listeners[onEvent] = (...args: unknown[]) => {
          record(name, args)
          const forward = attrs[onEvent] as ((...a: unknown[]) => void) | undefined
          forward?.(...args)
        }
      }
      return () => Vue.h(inner as never, { ...attrs, ...listeners } as never)
    },
  }
}

/**
 * Registers a real `components/fleet/*.vue` under the name Nuxt gives it: the directory prefix plus
 * the file name. Auto-import resolution is part of what a component depends on, so a test can wire
 * the real component instead of stubbing it.
 */
export function registerFleetComponents(app: { component: (name: string, c: Component) => void }): void {
  for (const [name, file] of Object.entries({
    FleetRepoReachabilityBadge: 'RepoReachabilityBadge.vue',
    FleetAge: 'Age.vue',
    FleetRunnerCapabilityChips: 'RunnerCapabilityChips.vue',
    FleetNativeSelect: 'NativeSelect.vue',
  })) {
    app.component(name, instantiate(webFile('components', 'fleet', file), {}, {}).default as Component)
  }
}

/** The globals a real `components/fleet/*.vue` needs: i18n, and a toast if it renders one. */
export function fleetComponentGlobals(): Record<string, unknown> {
  return { useI18n: () => ({ t: (key: string) => key, te: () => false }) }
}

const FLEET_COMPONENT_FILES: Record<FleetComponentName, string> = {
  FleetAge: 'Age.vue',
  FleetRunnerCapabilityChips: 'RunnerCapabilityChips.vue',
  FleetRepoReachabilityBadge: 'RepoReachabilityBadge.vue',
  FleetNativeSelect: 'NativeSelect.vue',
  FleetBudgetTable: 'BudgetTable.vue',
  FleetScheduleTable: 'ScheduleTable.vue',
  FleetScheduleHistory: 'ScheduleHistory.vue',
  FleetApprovalBudgetPanel: 'ApprovalBudgetPanel.vue',
  FleetApprovalOutcome: 'ApprovalOutcome.vue',
  FleetApprovalInbox: 'ApprovalInbox.vue',
  FleetApprovalBashPanel: 'ApprovalBashPanel.vue',
  FleetJobApprovals: 'JobApprovals.vue',
}

export function mountSfc(file: string, options: MountOptions = {}): Mounted {
  const globals = options.globals ?? {}
  const alias = { 'lucide-vue-next': vueIconStubs(), ...(options.alias ?? {}) }
  const records: [string, unknown[]][] = []
  const inner = instantiate(file, globals, alias).default as Component
  const root = node('#root')
  const app = renderer.createApp(withEmitRecorder(inner, (name, args) => records.push([name, args])), options.props ?? {})
  for (const [name, stub] of Object.entries(options.components ?? {})) app.component(name, stub as Component)
  // The real fleet components get the same globals the page gives them, so their own auto-imports
  // (useI18n) resolve without each test repeating that setup.
  const childGlobals = { useI18n: globals.useI18n, useAppToast: globals.useAppToast, ...globals }
  for (const name of options.fleetComponents ?? []) {
    app.component(name, instantiate(webFile('components', 'fleet', FLEET_COMPONENT_FILES[name]), childGlobals, alias).default as Component)
  }
  app.mount(root)
  const matches = (n: FakeNode, selector: string): boolean => {
  const attr = /^\[([\w-]+)="(.*)"\]$/.exec(selector)
  return attr ? n.props[attr[1]] === attr[2] : n.tag === selector
}

/** Collects the direct children of `node` matching the next selector in a chain. */
const descend = (chain: string[], node: FakeNode, into: FakeNode[]): FakeNode[] => {
  const [head, ...rest] = chain
  for (const child of node.children) {
    if (!matches(child, head)) continue
    if (rest.length === 0) into.push(child)
    else descend(rest, child, into)
  }
  return into
}

/**
 * Supports a tag, `[attr="value"]`, and a `>` direct-child chain. Enough to scope an assertion to
 * one table's rows without pulling in a CSS engine.
 */
const walk = (selector: string, from: FakeNode = root, into: FakeNode[] = []): FakeNode[] => {
  const chain = selector.split('>').map((part) => part.trim())
  for (const child of from.children) {
    if (matches(child, chain[0])) {
      if (chain.length === 1) into.push(child)
      else descend(chain.slice(1), child, into)
    }
    walk(selector, child, into)
  }
  return into
}
  return {
    root,
    find: (selector: string, scope?: FakeNode) => walk(selector, scope ?? root),
    one: (selector: string, scope?: FakeNode) => walk(selector, scope ?? root)[0],
    text: () => textOf(root),
    textOf,
    emitted: (name?: string) => records.filter(([n]) => name === undefined || n === name).map(([, args]) => args),
    unmount: () => app.unmount(),
  }
}

/** Lucide icons are ESM-only; a stub renders an empty span so the tree stays walkable. */
function vueIconStubs(): Record<string, unknown> {
  return new Proxy({}, { get: () => ({ name: 'Icon', template: '<i class="icon" />' }) })
}

/** The `~/lib`, `~/composables` and `~/components` paths a fleet component reaches for. */
export const webFile = (...parts: string[]): string => join(webRoot, ...parts)

/** The `components/fleet/*.vue` files, by the name Nuxt auto-imports them under. */
export type FleetComponentName =
  | 'FleetAge' | 'FleetRunnerCapabilityChips' | 'FleetRepoReachabilityBadge' | 'FleetNativeSelect' | 'FleetBudgetTable'
  | 'FleetScheduleTable' | 'FleetScheduleHistory'
  | 'FleetApprovalBudgetPanel' | 'FleetApprovalOutcome' | 'FleetApprovalInbox' | 'FleetApprovalBashPanel'
  | 'FleetJobApprovals'
