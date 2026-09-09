import type { Config } from 'jest';

/**
 * Unit tests.
 *
 * They live under test/unit/, mirroring the src/ tree they cover, so every test
 * in the project is reachable from one directory. rootDir is the package root
 * rather than src/ because the specs and the code they import now sit in
 * sibling trees.
 */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/unit/.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', {
      tsconfig: {
        // نعيد استخدام إعدادات tsconfig الرئيسية
        module: 'commonjs',
        emitDecoratorMetadata: true,
        experimentalDecorators: true,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        strictPropertyInitialization: false,
        skipLibCheck: true,
      },
    }],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
  // Coverage threshold — ratchet this upward over time as test coverage improves.
  // Starting at a realistic baseline that reflects current coverage.
  coverageThreshold: {
    global: {
      statements: 50,
      branches: 50,
      functions: 50,
      lines: 50,
    },
  },
};

export default config;
