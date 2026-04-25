module.exports = {
  root: true,
  extends: ['@nathapp/eslint-config/nest'],
  overrides: [
    {
      files: ['test/integration/rag/entity-store.integration.spec.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
};