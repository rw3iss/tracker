/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  verbose: true,
  maxWorkers: 1,
  globalSetup:  '<rootDir>/tests/framework/globalSetup.js',
  setupFiles:   ['<rootDir>/tests/framework/setupGlobals.js'],
  roots: ['<rootDir>/tests/specs'],
  moduleNameMapper: {
    '^@ven/tracker$': '<rootDir>/src/emitter/index.ts',
    '^@ven/tracker/emitter$': '<rootDir>/src/emitter/index.ts',
    '^@ven/tracker/consumer$': '<rootDir>/src/consumer/index.ts',
    '^@ven/tracker/storage$': '<rootDir>/src/consumer/storage/index.ts',
    '^@ven/tracker/notifications$': '<rootDir>/src/consumer/notifications/index.ts',
    '^@ven/tracker/breadcrumbs$':   '<rootDir>/src/emitter/plugins/index.ts',
    '^@ven/tracker/sw$':            '<rootDir>/src/emitter/sw/index.ts',
    '^@ven/tracker/types$':         '<rootDir>/src/common/index.ts',
    '^@ven/tracker/analytics$':     '<rootDir>/src/analytics/index.ts',
    '^@ven/tracker/ga$':            '<rootDir>/src/ga/index.ts',
    '^@ven/tracker/ga/server$':     '<rootDir>/src/ga/server/index.ts',
  },
};
