import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { RequestWithCookies } from '../common/types/request-context.types';
import { PrismaService } from '../prisma/prisma.service';
import { TokenRevocationService } from './token-revocation.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly cookieName: string;
  private readonly allowBearer: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tokenRevocation: TokenRevocationService,
  ) {
    const cookieName = config.get<string>('JWT_COOKIE_NAME', 'warehouse_access_token');
    const nodeEnv = config.get<string>('NODE_ENV', 'development');
    // السماح بالـ Bearer فقط في التطوير أو إذا تم تفعيله صراحة
    const allowBearer = config.get<boolean>('JWT_ALLOW_BEARER', nodeEnv !== 'production');

    super({
      // استخراج التوكن من الكوكيز أو الهيدر حسب الإعدادات
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => (req as RequestWithCookies)?.cookies?.[cookieName] || null,
        ...(allowBearer ? [ExtractJwt.fromAuthHeaderAsBearerToken()] : []),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      passReqToCallback: true,
    });

    this.cookieName = cookieName;
    this.allowBearer = allowBearer;
  }

  /**
   * دالة التحقق (القلب النابض للشرطي)
   */
  async validate(req: Request, payload: AuthenticatedUser): Promise<AuthenticatedUser> {
    // 1. التأكد من وجود معرف المستخدم في التوكن
    if (!payload?.userId) {
      throw new UnauthorizedException('توكن غير صالح');
    }

    // 2. استخراج التوكن الخام للتأكد من أنه ليس في القائمة السوداء (Revocation)
    const rawToken = this.extractRawToken(req);
    if (!rawToken || await this.tokenRevocation.isRevoked(rawToken)) {
      throw new UnauthorizedException('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً');
    }

    // 3. التحقق من حالة المستخدم في قاعدة البيانات (الأمان اللحظي)
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      include: { role: true },
    });

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('هذا الحساب لم يعد نشطاً');
    }

    // 4. بناء كائن المستخدم الذي سيتم استخدامه في كل الـ Controllers (عبر @CurrentUser)
    const roleName = user.role?.name || 'staff';

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: roleName,
      roles: [roleName],
      permissions: user.role?.permissions || [],
      iat: payload.iat,
      exp: payload.exp,
    };
  }

  /**
   * استخراج التوكن يدوياً للفحص
   */
  private extractRawToken(req: Request): string | null {
    const cookieToken = (req as RequestWithCookies)?.cookies?.[this.cookieName];
    if (cookieToken) return cookieToken;

    if (this.allowBearer) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
      }
    }

    return null;
  }
}