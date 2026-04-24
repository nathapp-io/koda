module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>"],
  testMatch: ["**/.nax/**/*.test.ts"],
  transform: { "^.+\\.(t|j)s$": "ts-jest" },
  testEnvironment: "node",
  forceExit: true,
  maxWorkers: 1,
  setupFilesAfterEnv: ["<rootDir>/test-setup.ts"],
};