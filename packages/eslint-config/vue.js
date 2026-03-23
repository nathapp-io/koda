module.exports = {
  extends: [require.resolve('./base.js')],
  root: false,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  ignorePatterns: ['.nuxt/', '.output/', 'generated/', 'node_modules/', 'dist/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
};
