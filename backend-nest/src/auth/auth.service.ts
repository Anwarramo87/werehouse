import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, createPublicKey, randomBytes, verify } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { TokenRevocationService } from './token-revocation.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { BiometricLoginFinishDto } from './dto/biometric-login-finish.dto';
import { BiometricLoginStartDto } from './dto/biometric-login-start.dto';
import { BiometricRegisterFinishDto } from './dto/biometric-register-finish.dto';
import { BiometricRegisterStartDto } from './dto/biometric-register-start.dto';
import { BiometricRevokeDto } from './dto/biometric-revoke.dto';
import {
  DEFAULT_MAX_LOGIN_ATTEMPTS,
  DEFAULT_LOCKOUT_MINUTES,
  BCRYPT_DEFAULT_ROUNDS,
  BIOMETRIC_CHALLENGE_BYTES,
  BIOMETRIC_CHALLENGE_TTL_SECONDS,
  AUTO_REFRESH_THRESHOLD_SECONDS,
} from '../common/constants/auth.constants';

type BiometricChallengePurpose = 'REGISTER' | 'LOGIN';

interface BiometricChallengeRecord {
  id: string;
  userId: string;
  purpose: BiometricChallengePurpose;
  challengeHash: string;
  challengeBase64: string;
  expiresAt: number;
  usedAt?: Date;
  keyId?: string;
  pendingPublicKeyBase64?: string;
  pendingDeviceName?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly biometricChallenges = new Map<string, BiometricChallengeRecord>();

  private static readonly ADMIN_PERMISSIONS = [
    'view_employees',
    'edit_employees',
    'delete_employees',
    'view_devices',
    'manage_devices',
    'manage_users',
    'manage_roles',
    'view_attendance',
    'edit_attendance',
    'view_payroll',
    'run_payroll',
    'approve_payroll',
    'view_inventory',
    'edit_inventory',
    'view_imports',
    'run_imports',
    'manage_salary',
    'manage_advances',
    'manage_insurance',
    'manage_bonuses',
    'manage_penalties',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly tokenRevocation: TokenRevocationService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  async login(dto: LoginDto) {
    const normalizedUsername = dto.username.trim();

    let user = await this.prisma.user.findFirst({
      where: { username: normalizedUsername },
      include: { role: true },
    });

    if (!user) {
      user = await this.prisma.user.findFirst({
        where: { email: normalizedUsername },
        include: { role: true },
      });
    }

    // Check lockout BEFORE password comparison to prevent brute-force on locked accounts
    if (user && this.isAccountLocked(user.lockoutUntil)) {
      throw new UnauthorizedException('الحساب مقفل حالياً');
    }

    const isPasswordCorrect = user
      ? await bcrypt.compare(dto.password, user.passwordHash)
      : await bcrypt.compare(dto.password, '$2a$10$n7.T/aVvE.R.v.v.v.v.v.v.v.v.v.v.v.v.v.v.v.v.v.v.v.v.');

    if (!user || !isPasswordCorrect) {
      if (user) {
        await this.registerFailedLoginAttempt(user);
      }
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockoutUntil: null, lastLogin: new Date() },
    });

    const payload = this.buildAuthPayload(user);
    return {
      token: await this.jwtService.signAsync(payload),
      user: this.toPublicAuthUser(user),
      roles: [user.role?.name || 'staff'],
      permissions: user.role?.permissions || [],
    };
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ username: dto.username }, { email: dto.email }] },
    });

    if (existing) {
      throw new BadRequestException('المستخدم موجود مسبقاً');
    }

    const role =
      (await this.prisma.role.findUnique({ where: { name: 'staff' } })) ??
      (await this.prisma.role.create({ data: { name: 'staff', permissions: ['view_attendance'] } }));

    const hash = await bcrypt.hash(dto.password, BCRYPT_DEFAULT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { username: dto.username, email: dto.email, passwordHash: hash, roleId: role.id },
      include: { role: true },
    });

    const payload = this.buildAuthPayload(user);
    return {
      token: await this.jwtService.signAsync(payload),
      user: this.toPublicAuthUser(user),
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!user) {
      throw new UnauthorizedException();
    }

    return { ...this.toPublicAuthUser(user), email: user.email, permissions: user.role?.permissions || [] };
  }

  async startBiometricRegistration(userId: string, dto: BiometricRegisterStartDto) {
    const challengeId = randomBytes(16).toString('hex');
    const challengeBase64 = randomBytes(BIOMETRIC_CHALLENGE_BYTES).toString('base64url');

    this.biometricChallenges.set(challengeId, {
      id: challengeId,
      userId,
      purpose: 'REGISTER',
      challengeHash: this.hashChallenge(challengeBase64),
      challengeBase64,
      expiresAt: Date.now() + BIOMETRIC_CHALLENGE_TTL_SECONDS * 1000,
      keyId: dto.keyId,
      pendingPublicKeyBase64: dto.publicKeyBase64,
      pendingDeviceName: dto.deviceName,
    });

    return { challengeId, challengeBase64 };
  }

  async finishBiometricRegistration(userId: string, dto: BiometricRegisterFinishDto) {
    const challenge = this.consumeChallenge(dto.challengeId, 'REGISTER', userId);
    if (!challenge) {
      throw new BadRequestException('تحدي غير صالح');
    }

    const publicKeyDer = this.buildSpkiPublicKeyDer(challenge.pendingPublicKeyBase64);

    await this.biometricCredentialModel().create({
      data: {
        keyId: challenge.keyId!,
        userId,
        publicKeyDer,
        deviceName: challenge.pendingDeviceName || undefined,
      },
    });

    return { ok: true };
  }

  async startBiometricLogin(dto: BiometricLoginStartDto) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: dto.username }, { email: dto.username }],
      },
      include: { role: true },
    });

    if (!user) {
      throw new UnauthorizedException('المستخدم غير موجود');
    }

    const credentials = await this.biometricCredentialModel().findMany({ where: { userId: user.id } });
    const challengeId = randomBytes(16).toString('hex');
    const challengeBase64 = randomBytes(BIOMETRIC_CHALLENGE_BYTES).toString('base64url');

    this.biometricChallenges.set(challengeId, {
      id: challengeId,
      userId: user.id,
      purpose: 'LOGIN',
      challengeHash: this.hashChallenge(challengeBase64),
      challengeBase64,
      expiresAt: Date.now() + BIOMETRIC_CHALLENGE_TTL_SECONDS * 1000,
    });

    return { challengeId, challengeBase64, allowedKeyIds: credentials.map((credential: { keyId: string }) => credential.keyId) };
  }

  async finishBiometricLogin(dto: BiometricLoginFinishDto) {
    const challenge = this.consumeChallenge(dto.challengeId, 'LOGIN');
    if (!challenge) {
      throw new BadRequestException('التحدي منتهي');
    }

    if (challenge.challengeBase64 !== dto.challengeBase64) {
      throw new BadRequestException('تحدي غير صالح');
    }

    const credential = await this.biometricCredentialModel().findFirst({
      where: { userId: challenge.userId, keyId: dto.keyId },
    });

    if (!credential) {
      throw new UnauthorizedException('بيانات البصمة غير صالحة');
    }

    const isValid = this.verifyBiometricSignature(
      challenge.challengeBase64,
      dto.signatureBase64,
      credential.publicKeyDer,
    );

    if (!isValid) {
      throw new UnauthorizedException('توقيع البصمة غير صالح');
    }

    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId }, include: { role: true } });
    if (!user) {
      throw new UnauthorizedException();
    }

    if (dto.markAttendance) {
      await this.handleAutoAttendance(user, dto);
    }

    const payload = this.buildAuthPayload(user);
    return { token: await this.jwtService.signAsync(payload), user: this.toPublicAuthUser(user) };
  }

  async revokeBiometric(userId: string, dto: BiometricRevokeDto) {
    await this.biometricCredentialModel().deleteMany({
      where: { userId, keyId: dto.keyId },
    });
    return { ok: true };
  }

  async createUser(dto: CreateUserDto) {
    const hash = await bcrypt.hash(dto.password, BCRYPT_DEFAULT_ROUNDS);
    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        passwordHash: hash,
        roleId: dto.roleId,
        status: dto.status || 'active',
      },
      include: { role: true },
    });

    return { user: this.toPublicAuthUser(user) };
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({ include: { role: true } });
    return { users: users.map((user) => ({ ...this.toPublicAuthUser(user), email: user.email, status: user.status })) };
  }

  async getRoles() {
    return this.prisma.role.findMany();
  }

  async revokeToken(token: string) {
    await this.tokenRevocation.revoke(token);
  }

  async rotateSessionIfNeeded(user: any) {
    const now = Math.floor(Date.now() / 1000);
    if (user?.exp && user.exp - now < AUTO_REFRESH_THRESHOLD_SECONDS) {
      const dbUser = await this.prisma.user.findUnique({ where: { id: user.userId }, include: { role: true } });
      if (dbUser) {
        return this.jwtService.signAsync(this.buildAuthPayload(dbUser));
      }
    }

    return null;
  }

  async ensureAdminBootstrap() {
    const adminRole =
      (await this.prisma.role.findUnique({ where: { name: 'admin' } })) ??
      (await this.prisma.role.create({ data: { name: 'admin', permissions: AuthService.ADMIN_PERMISSIONS } }));

    const password = this.config.get<string>('ADMIN_BOOTSTRAP_PASSWORD');
    if (!password && this.config.get('NODE_ENV') === 'production') {
      throw new Error('ADMIN_BOOTSTRAP_PASSWORD must be set in production');
    }

    const hash = await bcrypt.hash(password || 'password123', BCRYPT_DEFAULT_ROUNDS);
    const adminUsername = this.config.get('ADMIN_USERNAME', 'admin');
    const existingAdmin = await this.prisma.user.findUnique({ where: { username: adminUsername } });
    if (!existingAdmin) {
      await this.prisma.user.create({
        data: {
          username: adminUsername,
          email: this.config.get('ADMIN_EMAIL', 'admin@warehouse.local'),
          passwordHash: hash,
          roleId: adminRole.id,
          status: 'active',
        },
      });
    }
  }

  async ensureSuperadminBootstrap() {
    const adminRole =
      (await this.prisma.role.findUnique({ where: { name: 'admin' } })) ??
      (await this.prisma.role.create({ data: { name: 'admin', permissions: AuthService.ADMIN_PERMISSIONS } }));

    const username = this.config.get<string>('SUPERADMIN_USERNAME', 'superadmin');
    const email = this.config.get<string>('SUPERADMIN_EMAIL', 'superadmin@warehouse.local');
    const password = this.config.get<string>('SUPERADMIN_PASSWORD');

    if (!password && this.config.get('NODE_ENV') === 'production') {
      throw new Error('SUPERADMIN_PASSWORD must be set in production');
    }

    const hash = await bcrypt.hash(password || 'SuperAdmin@2026!', BCRYPT_DEFAULT_ROUNDS);
    const existingSuperadmin = await this.prisma.user.findUnique({ where: { username } });
    if (!existingSuperadmin) {
      await this.prisma.user.create({
        data: {
          username,
          email,
          passwordHash: hash,
          roleId: adminRole.id,
          status: 'active',
        },
      });
    }
  }

  private async handleAutoAttendance(user: any, dto: BiometricLoginFinishDto) {
    const employee = await this.prisma.employee.findFirst({
      where: { employeeId: user.username.toUpperCase() },
    });

    if (!employee) {
      return;
    }

    const now = new Date();
    // نستخدم التاريخ المحلي بدلاً من UTC لتجنب انحراف التاريخ
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const attendance = await this.prisma.attendanceRecord.create({
      data: {
        employeeId: employee.employeeId,
        type: dto.attendanceType || 'IN',
        timestamp: now,
        date: localDate,
        source: 'biometric',
      },
    });

    this.realtimeGateway.emitAttendanceUpdate({
      employeeId: employee.employeeId,
      employeeName: employee.name,
      type: attendance.type as any,
      timestamp: attendance.timestamp.toISOString(),
      date: attendance.date,
      time: now.toLocaleTimeString('ar-SY'),
      source: 'biometric',
      status: 'success',
      action: 'created',
      message: 'تسجيل حضور تلقائي',
    });
  }

  private buildAuthPayload(user: any) {
    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role?.name || 'staff',
      permissions: user.role?.permissions || [],
    };
  }

  private toPublicAuthUser(user: any) {
    return { id: user.id, username: user.username, role: user.role?.name || 'staff' };
  }

  private hashChallenge(value: string) {
    return createHash('sha256').update(value).digest('base64url');
  }

  private isAccountLocked(lockoutUntil: Date | null | undefined) {
    return !!lockoutUntil && lockoutUntil.getTime() > Date.now();
  }

  private async registerFailedLoginAttempt(user: any) {
    const attempts = (user.failedLoginAttempts || 0) + 1;

    if (attempts >= DEFAULT_MAX_LOGIN_ATTEMPTS) {
      const lockoutUntil = new Date(Date.now() + DEFAULT_LOCKOUT_MINUTES * 60_000);
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lockoutUntil, failedLoginAttempts: 0 },
      });
      return { locked: true };
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: attempts },
    });

    return { locked: false };
  }

  private verifyBiometricSignature(challengeBase64: string, signatureBase64: string, publicKeyDer: Buffer) {
    try {
      const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
      const challenge = Buffer.from(challengeBase64, 'base64url');
      const signature = Buffer.from(signatureBase64, 'base64url');
      return verify(null, challenge, publicKey, signature);
    } catch {
      return false;
    }
  }

  private consumeChallenge(challengeId: string, purpose: BiometricChallengePurpose, userId?: string) {
    const challenge = this.biometricChallenges.get(challengeId);
    if (!challenge) {
      return null;
    }

    if (challenge.usedAt || challenge.expiresAt < Date.now() || challenge.purpose !== purpose) {
      this.biometricChallenges.delete(challengeId);
      return null;
    }

    if (userId && challenge.userId !== userId) {
      return null;
    }

    challenge.usedAt = new Date();
    this.biometricChallenges.delete(challengeId);
    return challenge;
  }

  private buildSpkiPublicKeyDer(publicKeyBase64?: string) {
    if (!publicKeyBase64) {
      throw new BadRequestException('المفتاح العام غير صالح');
    }

    return Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKeyBase64, 'base64url'),
    ]);
  }

  private biometricCredentialModel() {
    return (this.prisma as any).biometricCredential;
  }
}
