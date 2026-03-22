module.exports = {
  preset: 'ts-jest',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', {
      tsconfig: {
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        skipLibCheck: true,
        moduleResolution: 'node',
        resolveJsonModule: true,
        declaration: false,
        strict: false,
      },
    }],
  },
  testEnvironment: 'node',
  forceExit: true,
  transformIgnorePatterns: [
    'node_modules/(?!chalk|conf|env-paths|dot-prop|atomically|debounce-fn)',
  ],
};
