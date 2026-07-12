import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StringValue } from 'ms';
import { RealtimeGateway } from './realtime.gateway';
import { WsJwtGuard } from './ws-jwt.guard';
import { TokenRevocationService } from '../auth/token-revocation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { JWT_DEFAULT_EXPIRE } from '../common/constants/auth.constants';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRE', JWT_DEFAULT_EXPIRE) as StringValue,
          algorithm: 'HS256',
        },
      }),
    }),
  ],
  providers: [RealtimeGateway, WsJwtGuard, TokenRevocationService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
