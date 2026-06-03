// auth.module.ts

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StringValue } from 'ms';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { AuditService } from '../common/services/audit.service';
import { TokenRevocationService } from './token-revocation.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    RealtimeModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const expiresIn = config.get<string>('JWT_EXPIRE', '1h'); 
        return {
          secret: config.getOrThrow<string>('JWT_SECRET'),
          signOptions: { 
            expiresIn: expiresIn as StringValue,
            algorithm: 'HS256',
          },
        };
      },
    }),
  ],
  providers: [
    AuthService, 
    JwtStrategy, 
    AuditService, 
    TokenRevocationService
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtModule, AuditService],
})
export class AuthModule {}