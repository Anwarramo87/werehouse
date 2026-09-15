import { BiometricService } from '../../../src/biometric/biometric.service';
import { ConfigService } from '@nestjs/config';

const stubDeps = {
  prisma: {} as never,
  duplicateHandler: {} as never,
  aggregationService: {} as never,
};

const configFor = (nodeEnv: string) =>
  new ConfigService({ NODE_ENV: nodeEnv });

describe('BiometricService production gate', () => {
  const origSimulator = process.env.USE_BIOMETRIC_SIMULATOR;

  afterEach(() => {
    process.env.USE_BIOMETRIC_SIMULATOR = origSimulator;
  });

  it('starts in hardware mode when production and the simulator is unset', () => {
    delete process.env.USE_BIOMETRIC_SIMULATOR;
    const service = new BiometricService(
      stubDeps.prisma,
      stubDeps.duplicateHandler,
      stubDeps.aggregationService,
      configFor('production'),
    );
    expect(service).toBeInstanceOf(BiometricService);
  });

  it('refuses to start in production with the simulator enabled', () => {
    process.env.USE_BIOMETRIC_SIMULATOR = 'true';
    expect(
      () =>
        new BiometricService(
          stubDeps.prisma,
          stubDeps.duplicateHandler,
          stubDeps.aggregationService,
          configFor('production'),
        ),
    ).toThrow(/not allowed in production/);
  });

  it('still allows the simulator outside production', () => {
    process.env.USE_BIOMETRIC_SIMULATOR = 'true';
    const service = new BiometricService(
      stubDeps.prisma,
      stubDeps.duplicateHandler,
      stubDeps.aggregationService,
      configFor('development'),
    );
    expect(service).toBeInstanceOf(BiometricService);
  });
});