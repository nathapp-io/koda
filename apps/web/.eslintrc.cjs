module.exports = {
  root: true,
  extends: ['@nathapp/eslint-config/vue'],
  rules: {
    'no-restricted-properties': [
      'error',
      {
        object: 'window',
        property: 'confirm',
        message: 'Use useConfirm() (styled dialog) instead of the native confirm.',
      },
      {
        object: 'globalThis',
        property: 'confirm',
        message: 'Use useConfirm() (styled dialog) instead of the native confirm.',
      },
    ],
    'no-restricted-globals': [
      'error',
      {
        name: 'confirm',
        message: 'Use useConfirm() (styled dialog) instead of the global confirm().',
      },
    ],
  },
  overrides: [
    {
      files: ['*.spec.ts'],
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
        'no-restricted-properties': 'off',
        'no-restricted-globals': 'off',
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
