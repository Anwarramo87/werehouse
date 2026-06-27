import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class DeviceApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const nodeEnv = this.config.get<string>('NODE_ENV', 'development');
    const configuredKey = this.config.get<string>('DEVICE_API_KEY', '').trim();

    if (nodeEnv !== 'production') {
      return true;
    }

    if (!configuredKey) {
      throw new UnauthorizedException('Device API is disabled in production');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = this.extractKey(request);

    if (!provided || !this.keysMatch(provided, configuredKey)) {
      throw new UnauthorizedException('Invalid device API key');
    }

    return true;
  }

  private extractKey(request: Request): string {
    const header = request.headers['x-device-api-key'];
    if (typeof header === 'string' && header.trim()) {
      return header.trim();
    }

    const auth = request.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice(7).trim();
    }

    return '';
  }

  private keysMatch(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}
