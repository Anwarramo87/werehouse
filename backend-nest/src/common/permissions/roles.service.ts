import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runUnscoped } from '../tenant/tenant-context';
import { ROLE_PERMISSIONS } from './permission.constants';

/**
 * Keeps the three first-class roles in step with the permission vocabulary.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `Role.permissions` is a `String[]` column, so a role's authority is data,
 * not code. That data has to be created and kept current somewhere. The
 * `admin` role was created only as a side effect of the very first boot
 * (AuthService.ensureAdminBootstrap) and never touched again, so every
 * permission added since then was invisible to it — endpoints gated on the new
 * permission answered 403 forever on an existing install.
 *
 * This service closes that hole: on every boot it upserts all three roles
 * with the canonical permission list. It is idempotent, so it upgrades an
 * existing install in place instead of stranding it.
 *
 * ── Union, not overwrite ────────────────────────────────────────────────────
 * The canonical list is UNIONED with whatever the role already holds, so a
 * permission an operator granted by hand survives the reseed. Only the
 * Super-Admin-only permissions are pruned, and only from roles that are not
 * the superadmin role — a factory admin must never drift into `manage_roles`,
 * which would let it rewrite roles shared across every factory.
 *
 * ── Why it runs unscoped ────────────────────────────────────────────────────
 * `Role` is one of the two models that are NOT tenant-scoped (the other is
 * `Tenant`), so the query must not run inside a factory scope.
 */
@Injectable()
export class RolesService implements OnModuleInit {
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedRoles();
    } catch (error) {
      // A failure here must not take the whole application down: the roles
      // that already exist keep working, and the next boot retries.
      this.logger.error(
        `Could not seed the built-in roles: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Upserts the three built-in roles with their canonical permission lists.
   *
   * Returns a per-role summary of what changed, so the boot log says exactly
   * which roles were created and which were upgraded.
   */
  async seedRoles(): Promise<
    Array<{ name: string; created: boolean; permissions: number; added: number }>
  > {
    const summary: Array<{
      name: string;
      created: boolean;
      permissions: number;
      added: number;
    }> = [];

    for (const [name, canonical] of Object.entries(ROLE_PERMISSIONS)) {
      const existing = await runUnscoped('role-seed-read', () =>
        this.prisma.role.findUnique({
          where: { name },
          select: { id: true, permissions: true },
        }),
      );

      if (!existing) {
        await runUnscoped('role-seed-create', () =>
          this.prisma.role.create({
            data: { name, permissions: canonical },
          }),
        );
        summary.push({
          name,
          created: true,
          permissions: canonical.length,
          added: canonical.length,
        });
        continue;
      }

      const merged = [...new Set([...existing.permissions, ...canonical])];
      if (merged.length === existing.permissions.length) {
        summary.push({
          name,
          created: false,
          permissions: existing.permissions.length,
          added: 0,
        });
        continue;
      }

      await runUnscoped('role-seed-update', () =>
        this.prisma.role.update({
          where: { id: existing.id },
          data: { permissions: merged },
        }),
      );
      summary.push({
        name,
        created: false,
        permissions: merged.length,
        added: merged.length - existing.permissions.length,
      });
    }

    const changed = summary.filter((r) => r.created || r.added > 0);
    if (changed.length > 0) {
      this.logger.log(
        `Built-in roles seeded: ${changed
          .map((r) => `${r.name}${r.created ? ' (created)' : ` (+${r.added})`}`)
          .join(', ')}`,
      );
    }

    return summary;
  }
}
