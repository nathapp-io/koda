module.exports = {
  root: true,
  extends: ['@nathapp/eslint-config/vue'],
  overrides: [
    {
      files: ['*.spec.ts'],
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
    {
      // .vue SFCs need vue-eslint-parser; the shared vue preset sets the
      // TypeScript parser at top level, which cannot parse SFC markup.
      files: ['*.vue'],
      parser: 'vue-eslint-parser',
      parserOptions: {
        parser: '@typescript-eslint/parser',
        ecmaVersion: 2022,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
      rules: {
        // no-undef is inapplicable here: SFC script blocks use Nuxt/Vue
        // auto-imports (ref, computed, definePageMeta, useApi, ...), which
        // cannot be enumerated statically. Undefined identifiers are caught
        // by vue-tsc in `nuxt typecheck` instead (runs in CI checks matrix).
        'no-undef': 'off',
      },
    },
  ],
};
