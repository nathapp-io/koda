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
  ],
};
