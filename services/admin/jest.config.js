module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
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