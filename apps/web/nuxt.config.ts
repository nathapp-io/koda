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

  runtimeConfig: {
    public: {
      apiBaseUrl: process.env.NUXT_PUBLIC_API_BASE_URL || 'http://localhost:3100/api',
    },
  },

  typescript: {
    strict: true,
  },
}) as unknown as Record<string, unknown>
