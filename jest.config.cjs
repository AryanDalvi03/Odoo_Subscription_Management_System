module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.ts', '<rootDir>/tests/unit/**/*.test.tsx'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          jsx: 'react-jsx',
          module: 'CommonJS',
          moduleResolution: 'Node',
          esModuleInterop: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    '^@subscriptiq/contracts$': '<rootDir>/packages/contracts/src/index.ts',
    '^@subscriptiq/ui$': '<rootDir>/packages/ui/src/index.ts',
    '^@subscriptiq/domain$': '<rootDir>/packages/domain/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: ['apps/api/src/app.ts', 'apps/api/src/config/env.ts'],
};
