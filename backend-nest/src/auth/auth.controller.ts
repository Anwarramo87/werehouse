import {
  Body,
  Controller,
  Get,
  Logger,
  OnModuleInit,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { BiometricLoginFinishDto } from './dto/biometric-login-finish.dto';
import { BiometricLoginStartDto } from './dto/biometric-login-start.dto';
import { BiometricRegisterFinishDto } from './dto/biometric-register-finish.dto';
import { BiometricRegisterStartDto } from './dto/biometric-register-start.dto';
import { BiometricRevokeDto } from './dto/biometric-revoke.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../common/services/audit.service';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { RequestWithCookies } from '../common/types/request-context.types';

@ApiTags('auth')
@Controller('auth')
export class AuthController implements OnModuleInit {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    try {
      await this.authService.ensureAdminBootstrap();
      await this.authService.ensureSuperadminBootstrap();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Admin bootstrap skipped: ${message}`);
    }
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({ summary: 'تسجيل الدخول', description: 'يقبل username أو email مع كلمة المرور، يُرجع JWT في HttpOnly Cookie' })
  @ApiResponse({ status: 200, description: 'تم تسجيل الدخول بنجاح' })
  @ApiResponse({ status: 401, description: 'بيانات الدخول غير صحيحة' })
  @ApiResponse({ status: 429, description: 'تجاوزت حد الطلبات المسموح' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto);
    this.setSessionCookies(res, result.token, result.refreshToken);
    res.setHeader('Cache-Control', 'no-store');
    return this.formatAuthResult(result);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.register(dto);
    this.setSessionCookies(res, result.token, result.refreshToken);
    res.setHeader('Cache-Control', 'no-store');
    return this.formatAuthResult(result);
  }

  @UseGuards(JwtAuthGuard)
  @Post('biometric/register/start')
  async biometricRegisterStart(
    @Body() dto: BiometricRegisterStartDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.authService.startBiometricRegistration(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('biometric/register/finish')
  async biometricRegisterFinish(
    @Body() dto: BiometricRegisterFinishDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.authService.finishBiometricRegistration(user.userId, dto);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('biometric/login/start')
  biometricLoginStart(@Body() dto: BiometricLoginStartDto) {
    return this.authService.startBiometricLogin(dto);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('biometric/login/finish')
  async biometricLoginFinish(
    @Body() dto: BiometricLoginFinishDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.finishBiometricLogin(dto);
    this.setSessionCookies(res, result.token, result.refreshToken);
    res.setHeader('Cache-Control', 'no-store');
    return this.formatAuthResult(result);
  }

  @UseGuards(JwtAuthGuard)
  @Post('biometric/revoke')
  biometricRevoke(@Body() dto: BiometricRevokeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.authService.revokeBiometric(user.userId, dto);
  }

  @Post('logout')
  @ApiOperation({ summary: 'تسجيل الخروج', description: 'يُلغي الـ JWT الحالي ويحذف الـ Cookie' })
  @ApiResponse({ status: 200, description: 'تم تسجيل الخروج بنجاح' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.extractTokenFromRequest(req);
    if (token) {
      await this.authService.revokeToken(token);
    }

    const refreshToken = this.extractRefreshTokenFromRequest(req);
    if (refreshToken) {
      await this.authService.revokeRefreshToken(refreshToken);
    }

    const cookieName = this.config.get<string>('JWT_COOKIE_NAME', 'warehouse_access_token');
    const refreshCookieName = this.config.get<string>(
      'JWT_REFRESH_COOKIE_NAME',
      'warehouse_refresh_token',
    );
    const { maxAge, ...cookieOptions } = this.getAuthCookieOptions();
    res.clearCookie(cookieName, cookieOptions);
    res.clearCookie(refreshCookieName, this.getRefreshCookieOptions());
    res.setHeader('Cache-Control', 'no-store');
    return { message: 'Logged out successfully' };
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token', description: 'Uses HttpOnly refresh cookie to issue a new access token' })
  @ApiResponse({ status: 200, description: 'Session refreshed' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = this.extractRefreshTokenFromRequest(req);
    if (!refreshToken) {
      res.status(401);
      return { message: 'Refresh token missing' };
    }

    const result = await this.authService.refreshSession(refreshToken);
    this.setSessionCookies(res, result.token, result.refreshToken);
    res.setHeader('Cache-Control', 'no-store');
    return this.formatAuthResult(result);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'بيانات المستخدم الحالي', description: 'يُرجع معلومات المستخدم المسجّل + يجدد الـ token إذا اقترب من الانتهاء' })
  @ApiResponse({ status: 200, description: 'بيانات المستخدم' })
  @ApiResponse({ status: 401, description: 'غير مصادق' })
  async me(@CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: Response) {
    const rotatedToken = await this.authService.rotateSessionIfNeeded(user);
    if (rotatedToken) {
      this.setAuthCookie(res, rotatedToken);
    }

    res.setHeader('Cache-Control', 'no-store');
    return this.authService.me(user.userId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('manage_users')
  @Post('users')
  async createUser(
    @Body() dto: CreateUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.authService.createUser(dto);
    this.audit.log(
      {
        action: 'user.create',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'user',
        targetId: result.user?.id,
        metadata: { username: result.user?.username, role: result.user?.role },
      },
      req,
    );
    return result;
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('manage_users')
  @Get('users')
  listUsers() {
    return this.authService.listUsers();
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('manage_roles')
  @Get('roles')
  async getRoles(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const roles = await this.authService.getRoles();
    this.audit.log(
      {
        action: 'role.read',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'role',
        metadata: { count: roles.length },
      },
      req,
    );
    return roles;
  }

  private setAuthCookie(res: Response, token: string) {
    const cookieName = this.config.get<string>('JWT_COOKIE_NAME', 'warehouse_access_token');
    res.cookie(cookieName, token, this.getAuthCookieOptions());
  }

  private setRefreshCookie(res: Response, refreshToken: string) {
    const cookieName = this.config.get<string>(
      'JWT_REFRESH_COOKIE_NAME',
      'warehouse_refresh_token',
    );
    res.cookie(cookieName, refreshToken, this.getRefreshCookieOptions());
  }

  private setSessionCookies(res: Response, accessToken: string, refreshToken: string) {
    this.setAuthCookie(res, accessToken);
    this.setRefreshCookie(res, refreshToken);
  }

  private formatAuthResult<T extends { token: string; refreshToken?: string }>(result: T) {
    const shouldReturnToken = this.config.get<boolean>('AUTH_RETURN_TOKEN_IN_BODY', false);
    if (shouldReturnToken) {
      return result;
    }

    const { token, refreshToken, ...sanitizedResult } = result;
    return sanitizedResult;
  }

  private getAuthCookieOptions() {
    const isProduction = this.config.get<string>('NODE_ENV', 'development') === 'production';
    const secureSetting = this.config.get<boolean>('JWT_COOKIE_SECURE', isProduction);
    const defaultSameSite = isProduction ? 'none' : 'lax';
    const sameSiteRaw = this.config
      .get<string>('JWT_COOKIE_SAME_SITE', defaultSameSite)
      .toLowerCase();
    const maxAge = this.config.get<number>('JWT_COOKIE_MAX_AGE_MS', 900_000);
    const rawDomain = this.config.get<string>('JWT_COOKIE_DOMAIN', '').trim();
    const domain =
      rawDomain && !rawDomain.includes('://') && !rawDomain.includes('/') && !rawDomain.includes(':')
        ? rawDomain
        : '';
    const configuredSameSite =
      sameSiteRaw === 'strict' || sameSiteRaw === 'none' ? sameSiteRaw : 'lax';
    const sameSite = configuredSameSite;

    return {
      httpOnly: true,
      secure: isProduction ? true : secureSetting || sameSite === 'none',
      sameSite,
      maxAge,
      path: '/',
      ...(domain ? { domain } : {}),
    } as const;
  }

  private getRefreshCookieOptions() {
    const isProduction = this.config.get<string>('NODE_ENV', 'development') === 'production';
    const secureSetting = this.config.get<boolean>('JWT_COOKIE_SECURE', isProduction);
    const defaultSameSite = isProduction ? 'none' : 'lax';
    const sameSiteRaw = this.config
      .get<string>('JWT_COOKIE_SAME_SITE', defaultSameSite)
      .toLowerCase();
    const days = this.config.get<number>('JWT_REFRESH_DAYS', 7);
    const maxAge = Math.max(1, days) * 24 * 60 * 60 * 1000;
    const rawDomain = this.config.get<string>('JWT_COOKIE_DOMAIN', '').trim();
    const domain =
      rawDomain && !rawDomain.includes('://') && !rawDomain.includes('/') && !rawDomain.includes(':')
        ? rawDomain
        : '';
    const configuredSameSite =
      sameSiteRaw === 'strict' || sameSiteRaw === 'none' ? sameSiteRaw : 'lax';
    const sameSite = configuredSameSite;

    return {
      httpOnly: true,
      secure: isProduction ? true : secureSetting || sameSite === 'none',
      sameSite,
      maxAge,
      path: '/api/auth/refresh',
      ...(domain ? { domain } : {}),
    } as const;
  }

  private extractTokenFromRequest(req: Request) {
    const cookieName = this.config.get<string>('JWT_COOKIE_NAME', 'warehouse_access_token');
    const cookieToken = (req as RequestWithCookies)?.cookies?.[cookieName];

    if (typeof cookieToken === 'string' && cookieToken.trim()) {
      return cookieToken;
    }

    const headerValue = req.headers.authorization;
    if (typeof headerValue === 'string' && headerValue.startsWith('Bearer ')) {
      const bearerToken = headerValue.slice(7).trim();
      return bearerToken || null;
    }

    return null;
  }

  private extractRefreshTokenFromRequest(req: Request) {
    const cookieName = this.config.get<string>(
      'JWT_REFRESH_COOKIE_NAME',
      'warehouse_refresh_token',
    );
    const cookieToken = (req as RequestWithCookies)?.cookies?.[cookieName];
    if (typeof cookieToken === 'string' && cookieToken.trim()) {
      return cookieToken.trim();
    }
    return null;
  }
}
