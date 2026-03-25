// https://nuxt.com/docs/api/configuration/nuxt-config

const isE2E = process.env['E2E_RUN'] === '1'

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

  // Proxy /api/** through Nuxt server → API container
  // Solves the Docker SSR problem: browser + SSR both use relative /api path,
  // Nuxt server proxies to the API service (http://api:3100 in Docker, localhost:3100 in dev)
  routeRules: {
    '/api/**': {
      proxy: `${process.env.NUXT_API_INTERNAL_URL || 'http://localhost:3100'}/api/**`,
    },
  },

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
