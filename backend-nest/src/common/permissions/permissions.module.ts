import { Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { PrismaModule } from '../../prisma/prisma.module';

/**
 * The permission vocabulary and the role seeding that keeps it in step with
 * the database.
 *
 * RolesService is exported so the admin panel can offer "refresh the built-in
 * roles" as an explicit action, but the real value is that it also runs on
 * every boot — an install that predates a permission must not be stuck
 * answering 403 on an endpoint the product says it has.
 */
@Module({
  imports: [PrismaModule],
  providers: [RolesService],
  exports: [RolesService],
})
export class PermissionsModule {}
