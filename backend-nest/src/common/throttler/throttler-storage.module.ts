import { Module } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Makes the Redis-backed rate-limit store injectable into
 * `ThrottlerModule.forRootAsync`.
 *
 * Declaring RedisThrottlerStorage in AppModule's `providers` is not enough:
 * forRootAsync's factory is resolved inside the dynamic module ThrottlerModule
 * creates, which cannot see AppModule's provider list. (ConfigService resolves
 * there only because ConfigModule is global.) The fix is a small module that
 * exports the store, imported by forRootAsync — the DI failure was
 * "Nest can't resolve dependencies of the THROTTLER:MODULE_OPTIONS
 * (ConfigService, ?)" at boot.
 */
@Module({
  providers: [
    RedisThrottlerStorage,
    { provide: ThrottlerStorage, useExisting: RedisThrottlerStorage },
  ],
  exports: [RedisThrottlerStorage, ThrottlerStorage],
})
export class ThrottlerStorageModule {}
