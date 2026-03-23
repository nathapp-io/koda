// https://nuxt.com/docs/api/configuration/nuxt-config

export default defineNuxtConfig({
  devtools: { enabled: true },

  modules: [
    '@nuxtjs/tailwindcss',
    '@nuxtjs/color-mode',
    'shadcn-nuxt',
  ],

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
