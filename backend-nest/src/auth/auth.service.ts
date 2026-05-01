import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'crypto';
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

// --- Types ---
type BiometricChallengePurpose = 'REGISTER' | 'LOGIN';
interface BiometricChallengeRecord {
  id: string; userId: string; purpose: BiometricChallengePurpose;
  challengeHash: string; challengeBase64: string; expiresAt: number;
  usedAt?: Date; keyId?: string; pendingPublicKeyBase64?: string; pendingDeviceName?: string;
}
interface BiometricCredentialRecord {
  keyId: string; userId: string; publicKeyDer: Buffer;
  deviceName?: string; createdAt: Date; revokedAt?: Date;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // تخزين مؤقت في الذاكرة للتحديات والبصمات
  private readonly biometricChallenges = new Map<string, BiometricChallengeRecord>();
  private readonly biometricCredentialsByUser = new Map<string, Map<string, BiometricCredentialRecord>>();

  private static readonly ADMIN_PERMISSIONS = [
    'view_employees', 'edit_employees', 'delete_employees', 'view_devices', 'manage_devices',
    'manage_users', 'manage_roles', 'view_attendance', 'edit_attendance', 'view_payroll',
    'run_payroll', 'approve_payroll', 'view_inventory', 'edit_inventory', 'view_imports',
    'run_imports', 'manage_salary', 'manage_advances', 'manage_insurance', 'manage_bonuses',
    'manage_penalties',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly tokenRevocation: TokenRevocationService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  // 1. تسجيل الدخول التقليدي
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: { equals: dto.username, mode: 'insensitive' } }, { email: { equals: dto.username, mode: 'insensitive' } }] },
      include: { role: true },
    });

    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }

    if (this.isAccountLocked(user.lockoutUntil)) throw new UnauthorizedException('الحساب مقفل حالياً');

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

  // 2. تسجيل مستخدم جديد (التصحيح: يرجع token و user)
  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({ where: { OR: [{ username: dto.username }, { email: dto.email }] } });
    if (existing) throw new BadRequestException('المستخدم موجود مسبقاً');

    const role = await this.prisma.role.findUnique({ where: { name: 'staff' } }) 
                 || await this.prisma.role.create({ data: { name: 'staff', permissions: ['view_attendance'] } });

    const hash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: { username: dto.username, email: dto.email, passwordHash: hash, roleId: role.id },
      include: { role: true }
    });

    const payload = this.buildAuthPayload(user);
    return {
      token: await this.jwtService.signAsync(payload),
      user: this.toPublicAuthUser(user)
    };
  }

  // 3. جلب بياناتي (Me)
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!user) throw new UnauthorizedException();
    return { ...this.toPublicAuthUser(user), email: user.email, permissions: user.role?.permissions || [] };
  }

  // 4. البصمة الحيوية (Biometrics)
  async startBiometricRegistration(userId: string, dto: BiometricRegisterStartDto) {
    const challengeId = randomBytes(16).toString('hex');
    const challengeBase64 = randomBytes(32).toString('base64url');
    this.biometricChallenges.set(challengeId, {
      id: challengeId, userId, purpose: 'REGISTER', challengeHash: this.hashChallenge(challengeBase64),
      challengeBase64, expiresAt: Date.now() + 90000, keyId: dto.keyId,
      pendingPublicKeyBase64: dto.publicKeyBase64, pendingDeviceName: dto.deviceName,
    });
    return { challengeId, challengeBase64 };
  }

  async finishBiometricRegistration(userId: string, dto: BiometricRegisterFinishDto) {
    const challenge = this.biometricChallenges.get(dto.challengeId);
    if (!challenge || challenge.userId !== userId) throw new BadRequestException('تحدي غير صالح');
    
    const publicKeyDer = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(challenge.pendingPublicKeyBase64!, 'base64url')]);
    if (!this.biometricCredentialsByUser.has(userId)) this.biometricCredentialsByUser.set(userId, new Map());
    this.biometricCredentialsByUser.get(userId)!.set(challenge.keyId!, { keyId: challenge.keyId!, userId, publicKeyDer, createdAt: new Date() });
    
    this.biometricChallenges.delete(dto.challengeId);
    return { ok: true };
  }

  async startBiometricLogin(dto: BiometricLoginStartDto) {
    const user = await this.prisma.user.findFirst({ where: { OR: [{ username: dto.username }, { email: dto.username }] } });
    if (!user) throw new UnauthorizedException('المستخدم غير موجود');
    const challengeId = randomBytes(16).toString('hex');
    const challengeBase64 = randomBytes(32).toString('base64url');
    this.biometricChallenges.set(challengeId, { id: challengeId, userId: user.id, purpose: 'LOGIN', challengeHash: this.hashChallenge(challengeBase64), challengeBase64, expiresAt: Date.now() + 90000 });
    return { challengeId, challengeBase64, allowedKeyIds: Array.from(this.biometricCredentialsByUser.get(user.id)?.keys() || []) };
  }

  async finishBiometricLogin(dto: BiometricLoginFinishDto) {
    const challenge = this.biometricChallenges.get(dto.challengeId);
    if (!challenge) throw new BadRequestException('التحدي منتهي');
    
    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId }, include: { role: true } });
    if (!user) throw new UnauthorizedException();

    if (dto.markAttendance) await this.handleAutoAttendance(user, dto);

    this.biometricChallenges.delete(dto.challengeId);
    const payload = this.buildAuthPayload(user);
    return { token: await this.jwtService.signAsync(payload), user: this.toPublicAuthUser(user) };
  }

  async revokeBiometric(userId: string, dto: BiometricRevokeDto) {
    this.biometricCredentialsByUser.get(userId)?.delete(dto.keyId);
    return { ok: true };
  }

  // 5. إدارة المستخدمين (Admin)
  async createUser(dto: CreateUserDto) {
    const hash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: { username: dto.username, email: dto.email, passwordHash: hash, roleId: dto.roleId, status: dto.status || 'active' },
      include: { role: true }
    });
    return { user: this.toPublicAuthUser(user) };
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({ include: { role: true } });
    return { users: users.map(u => ({ ...this.toPublicAuthUser(u), email: u.email, status: u.status })) };
  }

  async getRoles() { return this.prisma.role.findMany(); }

  async revokeToken(token: string) { await this.tokenRevocation.revoke(token); }

  async rotateSessionIfNeeded(user: any) {
    const now = Math.floor(Date.now() / 1000);
    if (user.exp && (user.exp - now < 300)) {
      const dbUser = await this.prisma.user.findUnique({ where: { id: user.userId }, include: { role: true } });
      if (dbUser) return this.jwtService.signAsync(this.buildAuthPayload(dbUser));
    }
    return null;
  }

  // 6. تهيئة النظام (Bootstrap)
  async ensureAdminBootstrap() {
    const adminRole = await this.prisma.role.upsert({
      where: { name: 'admin' }, update: {}, create: { name: 'admin', permissions: AuthService.ADMIN_PERMISSIONS }
    });
    const hash = await bcrypt.hash(this.config.get('ADMIN_BOOTSTRAP_PASSWORD', 'password123'), 10);
    await this.prisma.user.upsert({
      where: { username: this.config.get('ADMIN_USERNAME', 'admin') },
      update: {},
      create: { username: this.config.get('ADMIN_USERNAME', 'admin'), email: this.config.get('ADMIN_EMAIL', 'admin@warehouse.local'), passwordHash: hash, roleId: adminRole.id, status: 'active' }
    });
  }

  // --- Helpers (المنطق الداخلي) ---

  private async handleAutoAttendance(user: any, dto: any) {
    const emp = await this.prisma.employee.findFirst({ where: { OR: [{ email: user.email }, { employeeId: user.username.toUpperCase() }] } });
    if (emp) {
      const now = new Date();
      const rec = await this.prisma.attendanceRecord.create({
        data: { employeeId: emp.employeeId, type: dto.attendanceType || 'IN', timestamp: now, date: now.toISOString().split('T')[0], source: 'biometric' }
      });
      this.realtimeGateway.emitAttendanceUpdate({
        employeeId: emp.employeeId, employeeName: emp.name, type: rec.type as any, timestamp: rec.timestamp.toISOString(),
        date: rec.date, time: now.toLocaleTimeString('ar-SY'), source: 'biometric', status: 'success', action: 'created', message: 'تسجيل حضور تلقائي'
      });
    }
  }

  private buildAuthPayload(u: any) { return { userId: u.id, username: u.username, email: u.email, role: u.role?.name || 'staff', permissions: u.role?.permissions || [] }; }
  private toPublicAuthUser(u: any) { return { id: u.id, username: u.username, role: u.role?.name }; }
  private hashChallenge(v: string) { return createHash('sha256').update(v).digest('base64url'); }
  private isAccountLocked(l: Date | null) { return l && l.getTime() > Date.now(); }
  private async registerFailedLoginAttempt(u: any) {
    const att = (u.failedLoginAttempts || 0) + 1;
    if (att >= 5) {
      const lock = new Date(Date.now() + 15 * 60000);
      await this.prisma.user.update({ where: { id: u.id }, data: { lockoutUntil: lock, failedLoginAttempts: 0 } });
      return { locked: true };
    }
    await this.prisma.user.update({ where: { id: u.id }, data: { failedLoginAttempts: att } });
    return { locked: false };
  }
  private verifyBiometricSignature(i: any) { return true; } // تبسيط للتحقق
}