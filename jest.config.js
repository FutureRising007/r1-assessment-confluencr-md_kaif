/** @type {import('jest').Config} */
const base = {
  preset: 'ts-jest',
  testEnvironment: 'node',
};

module.exports = {
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts'],
  testTimeout: 30000,
  projects: [
    // Pure logic, no I/O: fast, runs anywhere.
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] },
    // Real PostgreSQL + real HTTP stack (supertest).
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      globalSetup: '<rootDir>/tests/setup/globalSetup.ts',
    },
  ],
};
