import { describe, test, expect, jest } from '@jest/globals'
import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import vm from 'vm'

// ─────────────────────────────────────────────────────────────────────────────
// Resolve Bun-hoisted dev-tooling packages (e.g. @vue/compiler-sfc, esbuild)
// by walking up from __dirname to find a node_modules/.bun/<encoded-name>@*
// directory. This avoids hardcoded absolute machine paths and the
// version+content-hash suffix in Bun's hoisted layout.
function resolveBunPackage(pkgName: string): string {
  let dir: string = __dirname
  const bunName = pkgName.startsWith('@') ? pkgName.replace('/', '+') : pkgName
  for (let i = 0; i < 100; i++) {
    const bunRoot = join(dir, 'node_modules', '.bun')
    if (existsSync(bunRoot) && statSync(bunRoot).isDirectory()) {
      const entries = (require('fs') as typeof import('fs')).readdirSync(bunRoot)
      const matches = entries
        .filter(e => e.startsWith(`${bunName}@`))
        .sort()
        .reverse()
      for (const entry of matches) {
        const inner = join(bunRoot, entry, 'node_modules', pkgName)
        if (existsSync(inner)) return inner
      }
    }
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Could not locate ${pkgName} in any node_modules/.bun/ from ${__dirname}`)
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sfc = require(resolveBunPackage('@vue/compiler-sfc'))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const esbuild = require(resolveBunPackage('esbuild'))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Vue = require(resolveBunPackage('vue'))

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', 'admin', 'slos.vue')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — compile the real SFC and mount it with stubbed globals.
// ─────────────────────────────────────────────────────────────────────────────

async function buildPageBundle(): Promise<string> {
  const source = readFileSync(pagePath, 'utf-8')
  const { descriptor } = sfc.parse(source)
  const scriptResult = sfc.compileScript(descriptor, { id: pagePath })

  const code = scriptResult.content
    .replace(/~\/composables\/useApi/g, join(webDir, 'composables/useApi'))
    .replace(
      'return __returned__',
      'globalThis.__SLOS_SETUP_STATE__ = __returned__;\n    return __returned__',
    )

  const result = await esbuild.build({
    stdin: { contents: code, resolveDir: webDir, loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vue', 'lucide-vue-next', join(webDir, 'composables/useApi')],
  })
  return result.outputFiles[0].text
}

interface MountOptions {
  fetchMock: jest.Mock
}

async function mountSlosPage(opts: MountOptions) {
  const { fetchMock } = opts
  const fetchCalls: Array<{ url: string; opts?: Record<string, unknown> }> = []
  const wrappedFetchMock = jest.fn(async (url: string, fetchOpts?: Record<string, unknown>) => {
    fetchCalls.push({ url, opts: fetchOpts })
    return await fetchMock(url, fetchOpts)
  })

  const toastInstance = { success: jest.fn(), error: jest.fn() }

  const pageBundle = await buildPageBundle()

  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
    require,
    __dirname: webDir,
    __filename: pagePath,
    console,
    process,
    Buffer,
    setTimeout, clearTimeout,

    ref: Vue.ref,
    computed: Vue.computed,

    useRoute: () => ({ path: '/admin/slos' }),
    useI18n: () => ({ t: (k: string) => k, locale: { value: 'en' } }),
    useAppToast: () => toastInstance,
    definePageMeta: () => {},
    onMounted: (fn: () => unknown) => { fn() },
    useApi: () => ({
      $api: {
        get: async (url: string, fetchOpts?: Record<string, unknown>) => {
          const envelope = await wrappedFetchMock(url, fetchOpts)
          return envelope?.data ?? envelope
        },
      },
    }),
  }
  sandbox.globalThis = sandbox

  vm.createContext(sandbox as vm.Context)
  sandbox.module = { exports: {} }
  vm.runInContext(pageBundle, sandbox as vm.Context)

  const Comp = (sandbox.module as { exports: { default?: { setup?: (...args: unknown[]) => unknown } } }).exports.default
  const setupFn = Comp?.setup
  if (typeof setupFn !== 'function') {
    throw new Error('compiled page has no setup function')
  }

  const bindings = setupFn.call(null, {}, { expose: () => {}, attrs: {}, slots: {}, emit: () => {} }) as Record<string, unknown>

  // Allow the onMounted-initiated fetch (and any error path) to resolve.
  await new Promise(resolve => setTimeout(resolve, 20))

  return { bindings, fetchCalls, toast: toastInstance }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — When $api.get resolves SLO metrics, the page renders a metric card per
//       returned metric with its label and value.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC1 (Behavioral SFC mount): page renders one metric card per returned metric', () => {
  test('mounting with two metrics produces two metric cards with label and value bindings', async () => {
    const fetchMock = jest.fn(async () => ({
      data: {
        metrics: [
          { label: 'Availability', value: 99.95 },
          { label: 'Latency p95', value: 120 },
        ],
      },
    }))

    const { bindings } = await mountSlosPage({ fetchMock })

    const metrics = bindings.metrics as { value: Array<{ label: string; value: number }> }
    expect(Array.isArray(metrics.value)).toBe(true)
    expect(metrics.value).toHaveLength(2)
    expect(metrics.value[0].label).toBe('Availability')
    expect(metrics.value[0].value).toBe(99.95)
    expect(metrics.value[1].label).toBe('Latency p95')
    expect(metrics.value[1].value).toBe(120)
  })

  test('mounting with an empty metrics list produces zero metric cards', async () => {
    const fetchMock = jest.fn(async () => ({ data: { metrics: [] } }))

    const { bindings } = await mountSlosPage({ fetchMock })

    const metrics = bindings.metrics as { value: Array<unknown> }
    expect(metrics.value).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — The page calls $api.get with the path /admin/slos.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC2 (Behavioral SFC mount): page calls $api.get with /admin/slos on mount', () => {
  test('mounting triggers $api.get("/admin/slos") at least once', async () => {
    const fetchMock = jest.fn(async () => ({ data: { metrics: [] } }))

    const { fetchCalls } = await mountSlosPage({ fetchMock })

    const slosCalls = fetchCalls.filter(c => c.url === '/admin/slos')
    expect(slosCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — Changing date-window controls re-invokes $api.get with from and to
//       query params carrying the selected window.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC3 (Behavioral SFC mount): changing the date window re-invokes $api.get with from/to query', () => {
  test('mutating the from ref and triggering reload re-invokes $api.get with from and to set', async () => {
    const fetchMock = jest.fn(async () => ({ data: { metrics: [] } }))

    const { fetchCalls, bindings } = await mountSlosPage({ fetchMock })
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1)

    const from = bindings.from as { value: string }
    const to = bindings.to as { value: string }
    const reload = bindings.reload as () => Promise<void>
    expect(typeof reload).toBe('function')

    from.value = '2026-01-01'
    to.value = '2026-01-31'
    await reload()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(fetchCalls.length).toBeGreaterThanOrEqual(2)
    const lastCall = fetchCalls[fetchCalls.length - 1]
    expect(lastCall.url).toBe('/admin/slos')
    const query = (lastCall.opts?.query ?? {}) as Record<string, string>
    expect(query.from).toBe('2026-01-01')
    expect(query.to).toBe('2026-01-31')
  })

  test('the second invocation carries the new window values, not the previous ones', async () => {
    const fetchMock = jest.fn(async () => ({ data: { metrics: [] } }))

    const { fetchCalls, bindings } = await mountSlosPage({ fetchMock })

    const from = bindings.from as { value: string }
    const to = bindings.to as { value: string }
    const reload = bindings.reload as () => Promise<void>

    from.value = '2026-02-01'
    to.value = '2026-02-28'
    await reload()
    await new Promise(resolve => setTimeout(resolve, 20))

    const latest = fetchCalls[fetchCalls.length - 1]
    const query = (latest.opts?.query ?? {}) as Record<string, string>
    expect(query.from).toBe('2026-02-01')
    expect(query.to).toBe('2026-02-28')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — While the request is pending, the page shows a loading indicator and
//       not the metric cards.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC4 (Behavioral SFC mount): pending state exposes a loading flag and clears after resolution', () => {
  test('pending is true while the fetch is in flight and false once it resolves', async () => {
    let resolveFetch: ((value: unknown) => void) | null = null
    const fetchMock = jest.fn(
      () => new Promise(resolve => { resolveFetch = resolve }),
    )

    const { bindings } = await mountSlosPage({ fetchMock })

    const pending = bindings.pending as { value: boolean }
    expect(pending.value).toBe(true)

    resolveFetch?.({ data: { metrics: [] } })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(pending.value).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — $api.get rejecting with a 403 ApiError renders an admin-only state
//       rather than a generic error toast.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC5 (Behavioral SFC mount): 403 ApiError renders an admin-only state, not a generic toast', () => {
  test('rejecting with ApiError code 403 sets adminOnly to true and does NOT call toast.error', async () => {
    const { ApiError } = require(join(webDir, 'composables/useApi'))
    const fetchMock = jest.fn(() => Promise.reject(new ApiError(403, 'Forbidden')))

    const { bindings, toast } = await mountSlosPage({ fetchMock })
    await new Promise(resolve => setTimeout(resolve, 30))

    const adminOnly = bindings.adminOnly as { value: boolean }
    expect(adminOnly.value).toBe(true)
    expect(toast.error).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — $api.get rejecting with a non-403 error surfaces extractApiError(err)
//       via the app toast.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC6 (Behavioral SFC mount): non-403 error surfaces extractApiError via toast.error', () => {
  test('rejecting with a generic ApiError(500) calls toast.error with extractApiError(err)', async () => {
    const { ApiError } = require(join(webDir, 'composables/useApi'))
    const fetchMock = jest.fn(() => Promise.reject(new ApiError(500, 'Internal Server Error')))

    const { toast } = await mountSlosPage({ fetchMock })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(toast.error).toHaveBeenCalledTimes(1)
    const calledWith = (toast.error as jest.Mock).mock.calls[0][0]
    expect(calledWith).toBe('Internal Server Error')
  })

  test('admin-only flag stays false on non-403 errors', async () => {
    const { ApiError } = require(join(webDir, 'composables/useApi'))
    const fetchMock = jest.fn(() => Promise.reject(new ApiError(500, 'Boom')))

    const { bindings } = await mountSlosPage({ fetchMock })
    await new Promise(resolve => setTimeout(resolve, 30))

    const adminOnly = bindings.adminOnly as { value: boolean }
    expect(adminOnly.value).toBe(false)
  })
})
