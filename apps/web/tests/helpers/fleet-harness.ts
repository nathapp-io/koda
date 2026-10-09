/**
 * Shared harness for behaviourally testing the fleet admin pages and dialogs.
 *
 * The pages are thin and depend on Nuxt auto-imports and the shadcn primitives, so mounting them
 * means supplying both: the Nuxt globals (i18n, toast, the fleet composables) and stubs for every
 * UI component they render. `uiStubs` renders each component as its own tag with its slots and
 * event handlers intact, which is what lets a test click a Button and read the emitted event.
 */
import { webFile } from './mount-sfc'

export interface ToastCall {
  kind: 'success' | 'error'
  message: string
}

export interface FleetGlobals {
  ref?: unknown
  computed?: unknown
  watch?: unknown
  onMounted?: unknown
  onBeforeUnmount?: unknown
  nextTick?: unknown
  useI18n?: unknown
  useAppToast?: unknown
  useApi?: unknown
  useRuntimeConfig?: unknown
}

import { h } from 'vue'
import type { VNodeChild } from 'vue'
// resolveJsonModule gives a typed, lint-clean import where `require()` is forbidden.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import enJson from '../../i18n/locales/en.json'

/**
 * Renders `tag`, forwarding attrs (so a test can read `onClick`, `variant`, …) and rendering every
 * slot including named ones. Defined with a render function rather than a `template` string on
 * purpose: a string template's own tag would resolve back to the registered component and recurse.
 */
/**
 * FormField hands its slot the vee-validate binding; the fleet dialogs bind `<Input
 * v-bind="componentField">` to it. A plain stub with no slot would leave that expression undefined.
 */
const inertComponentField = {
  modelValue: '',
  'onUpdate:modelValue': (): void => undefined,
  onBlur: (): void => undefined,
}

/**
 * Renders `tag`, forwarding every attr (so a test can read `onClick`, `variant`, `open`, …) and both
 * the default and `#actions` slots.
 *
 * `tag` must be one Vue cannot resolve back to a registered component name: a stub rendering e.g.
 * `<page-header>` would resolve to itself and recurse until the stack blew. The `x-` prefix keeps
 * these as inert elements.
 */
function elementStub(tag: string): unknown {
  return {
    name: `Stub${tag}`,
    inheritAttrs: false,
    setup(_props: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>; attrs: Record<string, unknown> }) {
      // Slots are invoked here and passed as an ARRAY: an element vnode's children must be an array
      // (an object is only meaningful for a component vnode, and is silently dropped here).
      // Passing the slots proxy directly loses PageHeader's #actions — the primary action button.
      return () => {
        const children: unknown[] = []
        for (const slot of [slots.default, slots.actions]) {
          if (!slot) continue
          const rendered = slot()
          if (Array.isArray(rendered)) children.push(...rendered)
          else if (rendered !== undefined && rendered !== null) children.push(rendered)
        }
        return h('x-stub-stub', { ...attrs, 'data-stub': tag }, children as VNodeChild[])
      }
    },
  }
}

/** A stub set covering every shadcn/app component the fleet pages and dialogs render. */
export const uiStubs: Record<string, unknown> = Object.fromEntries(
  [
    ['Dialog', 'dialog'], ['DialogContent', 'dialog-content'], ['DialogHeader', 'dialog-header'],
    ['DialogTitle', 'dialog-title'], ['DialogFooter', 'dialog-footer'], ['DialogDescription', 'dialog-description'],
    ['PageHeader', 'page-header'],
    ['NuxtLink', 'nuxt-link'],
    ['Table', 'table'], ['TableHeader', 'thead'], ['TableBody', 'tbody'],
    ['TableRow', 'tr'], ['TableHead', 'th'], ['TableCell', 'td'],
    ['Badge', 'badge'], ['Button', 'button'], ['Input', 'input'], ['Label', 'label'],
    ['Textarea', 'textarea'],
    ['Avatar', 'avatar'], ['AvatarFallback', 'avatar-fallback'], ['AvatarImage', 'avatar-image'],
    ['LoadingState', 'loading-state'], ['EmptyState', 'empty-state'],
    ['ErrorState', 'error-state'],
    ['Tabs', 'tabs'], ['TabsList', 'tabs-list'], ['TabsTrigger', 'tabs-trigger'], ['TabsContent', 'tabs-content'],
    ['FormItem', 'form-item'], ['FormLabel', 'form-label'], ['FormControl', 'form-control'],
    ['FormMessage', 'form-message'],
    ['FleetAge', 'fleet-age'], ['FleetRunnerCapabilityChips', 'capability-chips'],
    ['FleetNativeSelect', 'fleet-select'],
    // FleetRepoReachabilityBadge is deliberately NOT stubbed: a row's reachability label is the
    // page's main output, and the real badge is a pure presentational component.
  ].map(([name, tag]) => [name, elementStub(tag)]),
)

/**
 * The Edit dialog renders the name of the row it was opened with, so a page test can prove the
 * click reached the right runner. The dialog's own behaviour (validation, the patch, `saved`) is
 * covered by mounting the real component in tests/components.
 */
Object.assign(uiStubs, {
  FleetRunnerEditDialog: {
    name: 'StubFleetRunnerEditDialog',
    props: ['open', 'runner'],
    setup(props: { open?: boolean; runner?: { name?: string } }, { attrs }: { attrs: Record<string, unknown> }) {
      return () =>
        h('x-stub-stub', { ...attrs, 'data-stub': 'fleet-runner-edit-dialog', open: props.open === true }, props.runner?.name ?? '')
    },
  },
  // Like a real Dialog it stays mounted and toggles through `open`, so a test asserts that prop.
  FleetEnrollmentTokenDialog: {
    name: 'StubFleetEnrollmentTokenDialog',
    props: ['open'],
    setup(props: { open?: boolean }, { attrs }: { attrs: Record<string, unknown> }) {
      return () => h('x-stub-stub', { ...attrs, 'data-stub': 'fleet-enrollment-token-dialog', open: props.open === true })
    },
  },
  FleetBudgetEditDialog: {
    name: 'StubFleetBudgetEditDialog',
    props: ['open', 'policy'],
    setup(props: { open?: boolean; policy?: { id?: string } | null }, { attrs }: { attrs: Record<string, unknown> }) {
      return () =>
        h('x-stub-stub', { ...attrs, 'data-stub': 'fleet-budget-edit-dialog', open: props.open === true, 'data-policy': props.policy?.id ?? '' })
    },
  },
  FleetBudgetResumeDialog: {
    name: 'StubFleetBudgetResumeDialog',
    props: ['open', 'policy'],
    setup(props: { open?: boolean; policy?: { id?: string } | null }, { attrs }: { attrs: Record<string, unknown> }) {
      return () =>
        h('x-stub-stub', { ...attrs, 'data-stub': 'fleet-budget-resume-dialog', open: props.open === true, 'data-policy': props.policy?.id ?? '' })
    },
  },
  FleetScheduleEditDialog: {
    name: 'StubFleetScheduleEditDialog',
    props: ['open', 'schedule'],
    setup(props: { open?: boolean; schedule?: { id?: string } | null }, { attrs }: { attrs: Record<string, unknown> }) {
      return () =>
        h('x-stub-stub', { ...attrs, 'data-stub': 'fleet-schedule-edit-dialog', open: props.open === true, 'data-schedule': props.schedule?.id ?? '' })
    },
  },
})

// FormField hands its slot the vee-validate binding the dialogs bind to; nothing here can drive a
// real form, so the value is inert and form behaviour is covered by the dialogs' own specs.
Object.assign(uiStubs, {
  FormField: {
    name: 'StubFormField',
setup(_props: unknown, { slots }: { slots: Record<string, ((arg: unknown) => VNodeChild) | undefined> }) {
      const child = slots.default?.({ componentField: inertComponentField })
      return () =>
        h('x-stub-stub', { 'data-stub': 'form-field' }, child === undefined || child === null ? [] : [child])
    },
  },
})

/** i18n whose `t` returns the key, so a test can assert a key was rendered. */
export function i18nStub(): { t: (key: string) => string; te: () => boolean } {
  return { t: (key: string) => key, te: () => true }
}

/**
 * A `useAppToast` double that records what the admin was told. The recorder *is* the toast object,
 * so `toasts.errors` / `toasts.successes` read directly, and its call order is preserved.
 */
export interface ToastRecorder {
  errors: string[]
  successes: string[]
  calls: ToastCall[]
  error: (message: string) => void
  success: (message: string) => void
}

export function toastRecorder(): ToastRecorder {
  const calls: ToastCall[] = []
  const errors: string[] = []
  const successes: string[] = []
  return {
    calls,
    errors,
    successes,
    error: (message: string) => { errors.push(message); calls.push({ kind: 'error', message }) },
    success: (message: string) => { successes.push(message); calls.push({ kind: 'success', message }) },
  }
}

/** The en.json tree, so `t` returns the real English copy instead of a key. */
export const enLocale: Record<string, unknown> = enJson

/**
 * An i18n stub that resolves against the real en.json tree, interpolating `{name}` placeholders —
 * so an assertion sees the same string the browser would, not a raw `{n}`.
 */
export function enI18n(): { t: (key: string, named?: Record<string, unknown>) => string; te: (key: string) => boolean } {
  const lookup = (key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enLocale)
  const t = (key: string, named: Record<string, unknown> = {}): string => {
    const value = lookup(key)
    if (typeof value !== 'string') return key
    return value.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in named ? String(named[name]) : match)
  }
  return { t, te: (key) => lookup(key) !== undefined }
}

export const runnersPage = webFile('pages', 'admin', 'fleet', 'runners.vue')
export const reposPage = webFile('pages', 'admin', 'fleet', 'repos.vue')
export const enrollmentDialog = webFile('components', 'fleet', 'EnrollmentTokenDialog.vue')
export const runnerEditDialog = webFile('components', 'fleet', 'RunnerEditDialog.vue')
export const addRepoDialog = webFile('components', 'fleet', 'AddRepoDialog.vue')
export const reachabilityBadge = webFile('components', 'fleet', 'RepoReachabilityBadge.vue')
export const capabilityChips = webFile('components', 'fleet', 'RunnerCapabilityChips.vue')
export const ageComponent = webFile('components', 'fleet', 'Age.vue')

export const fleetGlobals = (over: Record<string, unknown>): Record<string, unknown> => ({
  useI18n: () => enI18n(),
  useAppToast: () => toastRecorder(),
  ...over,
})