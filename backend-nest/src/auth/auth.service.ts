import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, createPublicKey, randomBytes, verify } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { checkLeaveConflictForAttendance } from '../common/utils/leave-attendance-conflict.util';
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
import { BiometricChallengeService } from './biometric-challenge.service';
import { RefreshTokenService } from './refresh-token.service';
import { AuthCacheService } from './auth-cache.service';
import { toFactoryDateKey, resolveTimezoneOffsetMinutes } from '../common/utils/timezone.util';
import { currentTenant, runUnscoped } from '../common/tenant/tenant-context';
import {
  DEFAULT_TENANT_CODE,
  MANAGE_TENANTS,
  SUPERADMIN_ROLE,
} from '../common/tenant/tenant.constants';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { assertCanAssignRole, isSuperadminActor } from '../common/auth/role-assignment';

type BiometricChallengePurpose = 'REGISTER' | 'LOGIN';

type SessionResult = {
  token: string;
  refreshToken: string;
  user: { id: string; username: string; role: string };
  roles?: string[];
  permissions?: string[];
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly timezoneOffsetMinutes: number;
  private static readonly decoyHashes = new Map<number, string>();

  private static readonly ADMIN_PERMISSIONS = [
    'view_employees',
    'edit_employees',
    'delete_employees',
    'view_devices',
    'manage_devices',
    'manage_users',
    'view_attendance',
    'edit_attendance',
    'view_payroll',
    'run_payroll',
    'approve_payroll',
    'delete_payroll',
    'view_inventory',
    'edit_inventory',
    'view_imports',
    'run_imports',
    'manage_salary',
    'manage_advances',
    'manage_insurance',
    'manage_bonuses',
    'manage_penalties',
    'manage_trash',
    'manage_backups',
    'view_purchasing',
    'edit_purchasing',
    'view_sales',
    'edit_sales',
    'view_accounting',
    'edit_accounting',
    'notifications.view',
    // --- WMS extension ---
    // Batches, expiry rules, locations, QC and counting gate on the existing
    // inventory pair, and invoicing on the purchasing/sales pairs; these two
    // extra pairs exist for the roles a warehouse actually separates -- a
    // picker who may work a pick list but must not edit product costs.
    'view_batches',
    'edit_batches',
    'view_fulfillment',
    'edit_fulfillment',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly tokenRevocation: TokenRevocationService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly biometricChallenges: BiometricChallengeService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly authCache: AuthCacheService,
  ) {
    this.timezoneOffsetMinutes = resolveTimezoneOffsetMinutes(
      this.config.get<string>('APP_TIMEZONE_OFFSET_MINUTES'),
    );
  }

  private bcryptRounds(): number {
    return this.config.get<number>('BCRYPT_ROUNDS', BCRYPT_DEFAULT_ROUNDS);
  }

  /**
   * AUTH_MAX_LOGIN_ATTEMPTS and AUTH_LOCKOUT_MINUTES are declared and validated
   * in the config schema, but the lockout used to read the hard-coded constants
   * instead, so setting either environment variable did nothing at all.
   */
  private maxLoginAttempts(): number {
    return this.config.get<number>('AUTH_MAX_LOGIN_ATTEMPTS', DEFAULT_MAX_LOGIN_ATTEMPTS);
  }

  private lockoutMinutes(): number {
    return this.config.get<number>('AUTH_LOCKOUT_MINUTES', DEFAULT_LOCKOUT_MINUTES);
  }

  async login(dto: LoginDto) {
    const normalizedUsername = dto.username.trim();

    // Identity resolution is cross-tenant by definition: at this point we do
    // not yet know which factory the credential belongs to -- discovering that
    // is the whole point of the lookup. Usernames and emails remain globally
    // unique precisely so this stays unambiguous. Everything after the lookup
    // runs under the caller's own tenant via the JWT.
    // `employee` is included so the session can carry the staff identity; see
    // buildAuthPayload. It is a 1:1 relation, so this costs one join.
    const user = await runUnscoped('login-lookup', async () => {
      const withEmployee = { employee: { select: { employeeId: true } } };
      const byUsername = await this.prisma.user.findFirst({
        where: { username: normalizedUsername },
        include: withEmployee,
      });
      if (byUsername) return byUsername;
      return this.prisma.user.findFirst({
        where: { email: normalizedUsername },
        include: withEmployee,
      });
    });

    // Check lockout BEFORE password comparison to prevent brute-force on locked accounts
    if (user && this.isAccountLocked(user.lockoutUntil)) {
      throw new UnauthorizedException('الحساب مقفل حالياً');
    }

    // Comparing against a real hash for an unknown username keeps the response
    // time flat, so the endpoint does not leak which usernames exist. The
    // previous placeholder was not a well-formed bcrypt digest, so bcryptjs
    // rejected it immediately without doing the work -- which is precisely the
    // timing difference the comparison was there to hide. The cost must track
    // BCRYPT_ROUNDS, or a mismatch reintroduces the same signal.
    const isPasswordCorrect = user
      ? await bcrypt.compare(dto.password, user.passwordHash)
      : await bcrypt.compare(dto.password, this.timingDecoyHash());

    if (!user || !isPasswordCorrect) {
      if (user) {
        await this.registerFailedLoginAttempt(user);
      }
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }

    // Deactivating a user has to stop them at the door. Only JwtStrategy and
    // refreshSession checked `status`, so a suspended account could still log
    // in successfully and be issued a full session -- it merely failed on the
    // next request. Same wording as a wrong password: whether an account exists
    // and is suspended is not something an anonymous caller should learn.
    if (user.status !== 'active') {
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }

    // Must be `async () => await ...`: a PrismaPromise is lazy, so returning it
    // would defer execution until after this AsyncLocalStorage scope closed,
    // and the query would run under the request's empty scope instead.
    await runUnscoped('login-success', async () =>
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockoutUntil: null, lastLogin: new Date() },
      }),
    );

    // Explicitly fetch roles or use cached roles to build payload
    const allRoles = await this.getRoles();
    const userRole = allRoles.find((role) => role.id === user.roleId);
    const userWithRole = { ...user, role: userRole };

    const payload = this.buildAuthPayload(userWithRole);
    return this.createSession(userWithRole, payload);
  }

  async register(dto: RegisterDto) {
    // Registration is disabled by default. Set REGISTRATION_ENABLED=true in .env to allow it.
    const registrationEnabled = this.config.get<boolean>('REGISTRATION_ENABLED', false);
    if (!registrationEnabled) {
      throw new BadRequestException('Registration is disabled');
    }

    // Self-registration arrives with no session, so the request scope is empty
    // and every tenant-scoped query below would fail closed. The signup form
    // does not ask which factory the person belongs to, so the only defensible
    // answer is the default one -- the same factory the bootstrap admin owns.
    return runUnscoped('self-registration', async () => {
      const defaultTenant = await this.ensureDefaultTenant();

      const existing = await this.prisma.user.findFirst({
        where: { OR: [{ username: dto.username }, { email: dto.email }] },
      });

      if (existing) {
        throw new BadRequestException('المستخدم موجود مسبقاً');
      }

      const role =
        (await this.prisma.role.findUnique({ where: { name: 'staff' } })) ??
        (await this.prisma.role.create({
          data: { name: 'staff', permissions: ['view_attendance'] },
        }));

      const hash = await bcrypt.hash(dto.password, this.bcryptRounds());
      const user = await this.prisma.user.create({
        data: {
          username: dto.username,
          email: dto.email,
          passwordHash: hash,
          roleId: role.id,
          tenantId: defaultTenant.id,
        },
        include: { role: true },
      });

      const payload = this.buildAuthPayload(user);
      return this.createSession(user, payload);
    });
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

    await this.biometricChallenges.save({
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
    const challenge = await this.biometricChallenges.consume(dto.challengeId, 'REGISTER', userId);
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

    await this.biometricChallenges.save({
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
    const challenge = await this.biometricChallenges.consume(dto.challengeId, 'LOGIN');
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
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException();
    }

    if (dto.markAttendance) {
      await this.handleAutoAttendance(user, dto);
    }

    const payload = this.buildAuthPayload(user);
    return this.createSession(user, payload);
  }

  async revokeBiometric(userId: string, dto: BiometricRevokeDto) {
    await this.biometricCredentialModel().deleteMany({
      where: { userId, keyId: dto.keyId },
    });
    return { ok: true };
  }

  async createUser(dto: CreateUserDto, actor?: AuthenticatedUser) {
    // Privilege guard: only the overseer may mint admins/superadmins. A
    // factory admin with manage_users may only create ordinary accounts.
    if (dto.roleId) {
      const targetRole = await this.prisma.role.findUnique({
        where: { id: dto.roleId },
        select: { name: true },
      });
      assertCanAssignRole(targetRole?.name ?? null, actor);
    }

    const hash = await bcrypt.hash(dto.password, this.bcryptRounds());

    // A factory admin runs with bypass=false, so the tenant extension stamps
    // their own tenantId onto the row and dto.tenantId is ignored -- they can
    // only ever create users inside their own factory. The super admin runs
    // with bypass=true, which skips stamping entirely: without naming a factory
    // the new user would land with tenantId NULL, and a non-superadmin with no
    // factory fails every tenant-scoped query with a 500.
    const scope = currentTenant();
    const tenantId = scope?.bypass ? (dto.tenantId ?? null) : (scope?.tenantId ?? null);

    if (scope?.bypass && !tenantId) {
      throw new BadRequestException(
        'tenantId is required: a user must belong to a factory',
      );
    }

    if (tenantId) {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        throw new BadRequestException('Factory not found');
      }
    }

    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        passwordHash: hash,
        roleId: dto.roleId,
        status: dto.status || 'active',
        photo: dto.photo,
        ...(tenantId ? { tenantId } : {}),
      },
      include: { role: true },
    });

    return { user: this.toPublicAuthUser(user) };
  }

  async listUsers(actor?: AuthenticatedUser) {
    // The overseer sees everyone. A factory admin sees only ordinary accounts
    // of their OWN factory — never superadmins, never fellow admins, never
    // other factories. Admins must not see each other.
    if (isSuperadminActor(actor)) {
      const users = await this.prisma.user.findMany({ include: { role: true } });
      return {
        users: users.map((user) => ({
          ...this.toPublicAuthUser(user),
          email: user.email,
          status: user.status,
        })),
      };
    }

    const tenantId = actor?.tenantId ?? null;
    if (!tenantId) return { users: [] };

    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        role: { name: { notIn: [SUPERADMIN_ROLE, 'admin'] } },
      },
      include: { role: true },
    });
    return {
      users: users.map((user) => ({
        ...this.toPublicAuthUser(user),
        email: user.email,
        status: user.status,
      })),
    };
  }

  async getRoles() {
    const cachedRoles = await this.authCache.getRoles();
    if (cachedRoles) {
      return cachedRoles;
    }

    const roles = await this.prisma.role.findMany();
    await this.authCache.setRoles(roles);
    return roles;
  }

  async revokeToken(token: string) {
    await this.tokenRevocation.revoke(token);
  }

  async revokeRefreshToken(refreshToken: string) {
    await this.refreshTokens.revoke(refreshToken);
  }

  async refreshSession(refreshToken: string): Promise<SessionResult> {
    return runUnscoped('refresh-session', async () => {
    const userId = await this.refreshTokens.consume(refreshToken);
    if (!userId) {
      throw new UnauthorizedException('Refresh token expired or invalid');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true, employee: { select: { employeeId: true } } },
    });

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Account is no longer active');
    }

    await this.authCache.invalidateUser(userId);
    return this.createSession(user, this.buildAuthPayload(user));
  });
  }

  async rotateSessionIfNeeded(user: any) {
    const now = Math.floor(Date.now() / 1000);
    if (user?.exp && user.exp - now < AUTO_REFRESH_THRESHOLD_SECONDS) {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: user.userId },
        include: { role: true, employee: { select: { employeeId: true } } },
      });
      if (dbUser) {
        await this.authCache.invalidateUser(dbUser.id);
        return this.jwtService.signAsync(this.buildAuthPayload(dbUser));
      }
    }

    return null;
  }

  /**
   * Grants any permission the role is missing from its canonical list.
   *
   * `permissions` used to be written only when the role row was first created,
   * so a permission added to ADMIN_PERMISSIONS later never reached an existing
   * install -- every endpoint gated on it answered 403 forever. Union rather
   * than overwrite so permissions an operator added by hand survive.
   */
  private async reconcileRolePermissions(
    role: { id: string; permissions: string[] },
    canonical: string[],
  ) {
    const missing = canonical.filter((p) => !role.permissions.includes(p));
    if (missing.length === 0) {
      return role;
    }

    const updated = await this.prisma.role.update({
      where: { id: role.id },
      data: { permissions: [...role.permissions, ...missing] },
    });
    await this.authCache.invalidateAllRoles();
    await this.authCache.invalidateAllUsers();
    return updated;
  }

  /**
   * Rotates a bootstrap account's password, but only when explicitly asked to.
   *
   * The bootstrap sets a password when it CREATES an account and never again,
   * which means changing ADMIN_BOOTSTRAP_PASSWORD or SUPERADMIN_PASSWORD in the
   * environment looks like a rotation and silently is not: the hash in the
   * database keeps whatever it was on first boot. That is how a password can
   * stay live long after the operator believes they replaced it.
   *
   * Syncing on every boot would be worse -- it would fight any password changed
   * by hand, and would re-apply a compromised value on every restart. So the
   * reset is opt-in: name the accounts in AUTH_FORCE_PASSWORD_RESET, deploy
   * once, then remove the variable.
   */
  private async rotateBootstrapPasswordIfRequested(
    user: { id: string; username: string },
    hash: string,
  ): Promise<boolean> {
    const raw = this.config.get<string>('AUTH_FORCE_PASSWORD_RESET', '').trim();
    if (!raw) return false;

    const wanted = raw.toLowerCase() === 'all'
      ? null
      : new Set(raw.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean));

    if (wanted && !wanted.has(user.username.toLowerCase())) return false;

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, failedLoginAttempts: 0, lockoutUntil: null },
    });
    await this.authCache.invalidateUser(user.id);

    this.logger.warn(
      `Password for "${user.username}" was reset from the environment because ` +
        `AUTH_FORCE_PASSWORD_RESET names it. Remove that variable once the ` +
        `deploy has completed, or the password resets on every restart.`,
    );
    return true;
  }

  /**
   * The factory a bootstrapped admin belongs to.
   *
   * Every model but Role and Tenant is tenant-scoped, and a non-superadmin
   * principal with no factory fails `requireScope()` on its very first query --
   * so an admin created without one can log in and then gets a 500 from every
   * endpoint. Creating the factory here rather than in a manual script means a
   * fresh deployment is usable without one.
   */
  private async ensureDefaultTenant() {
    const existing = await this.prisma.tenant.findUnique({
      where: { code: DEFAULT_TENANT_CODE },
    });
    if (existing) {
      return existing;
    }

    return this.prisma.tenant.create({
      data: { name: 'Default', code: DEFAULT_TENANT_CODE, status: 'active' },
    });
  }

  async ensureAdminBootstrap() {
    return runUnscoped('bootstrap-admin', async () => {
    const defaultTenant = await this.ensureDefaultTenant();
    const existingAdminRole = await this.prisma.role.findUnique({ where: { name: 'admin' } });
    const adminRole = existingAdminRole
      ? await this.reconcileRolePermissions(existingAdminRole, AuthService.ADMIN_PERMISSIONS)
      : await this.prisma.role.create({
          data: { name: 'admin', permissions: AuthService.ADMIN_PERMISSIONS },
        });

    const password = this.config.get<string>('ADMIN_BOOTSTRAP_PASSWORD');
    if (!password && this.config.get('NODE_ENV') === 'production') {
      throw new Error('ADMIN_BOOTSTRAP_PASSWORD must be set in production');
    }

    const hash = await bcrypt.hash(password || 'password123', this.bcryptRounds());
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
          tenantId: defaultTenant.id,
        },
      });
    } else {
      await this.rotateBootstrapPasswordIfRequested(existingAdmin, hash);
    }

    if (existingAdmin && !existingAdmin.tenantId) {
      // An admin created before multi-tenancy (or by an earlier build of this
      // bootstrap) carries no factory and is locked out of every endpoint.
      await this.prisma.user.update({
        where: { id: existingAdmin.id },
        data: { tenantId: defaultTenant.id },
      });
      await this.authCache.invalidateUser(existingAdmin.id);
    }
  });
  }

  async ensureSuperadminBootstrap() {
    return runUnscoped('bootstrap-superadmin', async () => {
    // The overseer needs its OWN role, distinct from the per-factory `admin`.
    // They used to share the `admin` role, which is why the two were
    // indistinguishable; PermissionsGuard now grants blanket access to
    // `superadmin` only, so a factory admin no longer inherits overseer rights.
    const superadminPermissions = [
      ...AuthService.ADMIN_PERMISSIONS,
      MANAGE_TENANTS,
      'manage_roles',
    ];
    const existingSuperadminRole = await this.prisma.role.findUnique({
      where: { name: SUPERADMIN_ROLE },
    });
    const superadminRole = existingSuperadminRole
      ? await this.reconcileRolePermissions(existingSuperadminRole, superadminPermissions)
      : await this.prisma.role.create({
          data: {
            name: SUPERADMIN_ROLE,
            description: 'Overseer: sees every factory, manages tenants and global backups',
            permissions: superadminPermissions,
          },
        });

    const username = this.config.get<string>('SUPERADMIN_USERNAME', 'superadmin');
    const email = this.config.get<string>('SUPERADMIN_EMAIL', 'superadmin@warehouse.local');
    const password = this.config.get<string>('SUPERADMIN_PASSWORD');

    if (!password && this.config.get('NODE_ENV') === 'production') {
      throw new Error('SUPERADMIN_PASSWORD must be set in production');
    }

    const hash = await bcrypt.hash(password || 'SuperAdmin@2026!', this.bcryptRounds());
    const existingSuperadmin = await this.prisma.user.findUnique({ where: { username } });
    if (!existingSuperadmin) {
      await this.prisma.user.create({
        data: {
          username,
          email,
          passwordHash: hash,
          roleId: superadminRole.id,
          // Explicitly null: the overseer belongs to no single factory. Said
          // out loud because the tenant extension refuses a bypassed create
          // that simply omits it.
          tenantId: null,
          status: 'active',
        },
      });
    } else {
      if (existingSuperadmin.roleId !== superadminRole.id) {
        // Existing installs have a superadmin still carrying the shared `admin`
        // role. Promote it, otherwise the guard change locks them out entirely.
        await this.prisma.user.update({
          where: { id: existingSuperadmin.id },
          data: { roleId: superadminRole.id, tenantId: null },
        });
      }

      await this.rotateBootstrapPasswordIfRequested(existingSuperadmin, hash);
    }
  });
  }

  private async handleAutoAttendance(user: any, dto: BiometricLoginFinishDto) {
    const employee = await this.prisma.employee.findFirst({
      where: { employeeId: user.username.toUpperCase() },
    });

    if (!employee) {
      return;
    }

    const now = new Date();
    const localDate = toFactoryDateKey(now, this.timezoneOffsetMinutes);

    try {
      await checkLeaveConflictForAttendance(this.prisma, employee.employeeId, localDate);
    } catch (err) {
      this.logger.warn(
        `Auto-attendance skipped for ${employee.employeeId} on ${localDate}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

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

  private async createSession(user: any, payload: Record<string, unknown>): Promise<SessionResult> {
    const token = await this.jwtService.signAsync(payload);
    const refreshToken = await this.refreshTokens.issue(user.id);

    return {
      token,
      refreshToken,
      user: this.toPublicAuthUser(user),
      roles: [user.role?.name || 'staff'],
      permissions: user.role?.permissions || [],
    };
  }

  private buildAuthPayload(user: any) {
    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role?.name || 'staff',
      permissions: user.role?.permissions || [],
      tenantId: user.tenantId ?? null,
      // Only ever taken from the User->Employee relation, never from anything
      // the caller supplied.
      employeeId: user.employee?.employeeId ?? null,
    };
  }

  private toPublicAuthUser(user: any) {
    return {
      id: user.id,
      username: user.username,
      role: user.role?.name || 'staff',
      photo: user.photo || null,
      tenantId: user.tenantId ?? null,
    };
  }

  /**
   * A real bcrypt digest of a value nobody can supply, cached per cost factor
   * so the decoy comparison costs the same as a genuine one.
   */
  private timingDecoyHash(): string {
    const rounds = this.bcryptRounds();
    let hash = AuthService.decoyHashes.get(rounds);
    if (!hash) {
      hash = bcrypt.hashSync(randomBytes(32).toString('hex'), rounds);
      AuthService.decoyHashes.set(rounds, hash);
    }
    return hash;
  }

  private hashChallenge(value: string) {
    return createHash('sha256').update(value).digest('base64url');
  }

  private isAccountLocked(lockoutUntil: Date | null | undefined) {
    return !!lockoutUntil && lockoutUntil.getTime() > Date.now();
  }

  // Brute-force bookkeeping runs on a failed login, i.e. before any tenant is
  // established, so it has to be unscoped like the lookup that preceded it.
  private async registerFailedLoginAttempt(user: any) {
    const attempts = (user.failedLoginAttempts || 0) + 1;

    if (attempts >= this.maxLoginAttempts()) {
      const lockoutUntil = new Date(Date.now() + this.lockoutMinutes() * 60_000);
      await runUnscoped('login-lockout', async () =>
        await this.prisma.user.update({
          where: { id: user.id },
          data: { lockoutUntil, failedLoginAttempts: 0 },
        }),
      );
      return { locked: true };
    }

    await runUnscoped('login-failed-attempt', async () =>
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: attempts },
      }),
    );

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
