// https://nuxt.com/docs/api/configuration/nuxt-config

const isE2E = process.env['E2E_RUN'] === '1'
const SHADCN_COMPONENT_DIR_SUFFIX = '/components/ui'

const shadcnComponentsDirFilterModule = (
  _options: unknown,
  nuxt: {
    hook: (name: 'components:dirs', cb: (dirs: Array<string | { path?: string }>) => void) => void
  },
) => {
  nuxt.hook('components:dirs', (dirs) => {
    for (let i = dirs.length - 1; i >= 0; i--) {
      const dir = dirs[i]
      const dirPath = typeof dir === 'string' ? dir : dir.path
      if (typeof dirPath === 'string' && dirPath.replace(/\\/g, '/').endsWith(SHADCN_COMPONENT_DIR_SUFFIX)) {
        dirs.splice(i, 1)
      }
    }
  })
}

export default defineNuxtConfig({
  devtools: { enabled: !isE2E },

  components: [
    {
      path: '~/components',
      extensions: ['vue'],
    },
  ],

  css: ['~/assets/css/globals.css'],

  modules: [
    '@nuxtjs/tailwindcss',
    '@nuxtjs/color-mode',
    'shadcn-nuxt',
    shadcnComponentsDirFilterModule,
    '@nuxtjs/i18n',
  ],

  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'en',
    langDir: 'locales',
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'zh', name: '中文', file: 'zh.json' },
    ],
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'koda_locale',
      alwaysRedirect: false,
      fallbackLocale: 'en',
    },
  },

  shadcn: {
    prefix: '',
    componentDir: './components/ui',
  },

  colorMode: {
    classSuffix: '',
  },

  // Proxy /api/** through Nuxt server → API container is implemented by the
  // Nitro catch-all handler at server/api/[...].ts (M23). It reads
  // NUXT_API_INTERNAL_URL at runtime (a build-time routeRules proxy froze the
  // target at build time) and never shadows server/api/auth/* filesystem
  // routes, so the httpOnly cookie session can be established.

  runtimeConfig: {
    // Server-side only: internal URL for SSR → API calls
    apiInternalUrl: process.env.NUXT_API_INTERNAL_URL || 'http://localhost:3100',
    public: {
      // Client-side: relative path — requests go to Nuxt server, which proxies to API
      apiBaseUrl: '/api',
    },
  },

  typescript: {
    strict: true,
  },
}) as unknown as Record<string, unknown>
