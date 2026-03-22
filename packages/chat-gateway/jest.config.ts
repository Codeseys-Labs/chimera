import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts',
  ],
  moduleNameMapper: {
    '^@chimera/shared$': '<rootDir>/../shared/src',
    '^@chimera/core$': '<rootDir>/../core/src',
    '^@chimera/sse-bridge$': '<rootDir>/../sse-bridge/src',
  },
  testTimeout: 15000,
  verbose: true,
  setupFiles: ['<rootDir>/jest.setup.ts'],
};

export default config;
