module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/app/config-app/test', '<rootDir>/app/connections-app/test', '<rootDir>/app/grounding-app/test', '<rootDir>/app/model-library-app/test', '<rootDir>/app/plugins-app/test', '<rootDir>/app/shell/test', '<rootDir>/app/tool-policies-app/test', '<rootDir>/app/usage-analytics-app/test'],
  testMatch: [
    '**/test/**/*.test.ts',
    '**/test/**/*.spec.ts'
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.{ts,js}',
    '!src/**/*.d.ts',
    '!src/**/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/test/setupTests.ts'],
  testTimeout: 30000,
  maxWorkers: 1,
  // With one worker jest runs every suite inside its own main process unless a memory limit is set,
  // and that heap only grows: on a cold ts-jest cache it reached ~1.9 GB, the GitHub runner's heap limit
  // (private run 42173387136 died of it). The limit keeps one worker but restarts it between suites
  // once it holds more than this.
  workerIdleMemoryLimit: '1GB',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@libs/(.*)$': '<rootDir>/../../libs/$1',
    '^@sap-llm-gateway/libs/(.*)$': '<rootDir>/../../libs/$1',
    '^bcrypt$': '<rootDir>/test/__mocks__/bcrypt.js'
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/gen/'
  ],
  forceExit: true
};