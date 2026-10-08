module.exports = {
  root: true,
  extends: ['@nathapp/eslint-config/nest'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [{ name: '@prisma/client', message: 'Import from the generated client (src/generated/prisma/client) instead.' }],
    }],
  },
  overrides: [
    {
      files: ['test/integration/rag/entity-store.integration.spec.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
};