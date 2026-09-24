import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SuperAdminGuard } from '../common/guards/superadmin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SUPERADMIN_ROLE } from '../common/tenant/tenant.constants';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CustomizationPatchInput, CustomizationService } from './customization.service';

const NO_TENANT_MESSAGE =
  'This endpoint is factory-scoped. The super admin must use the tenant-id variant of the route instead.';

function assertTenantScope(
  user: AuthenticatedUser,
): asserts user is AuthenticatedUser & { tenantId: string } {
  const isSuperAdmin =
    (user.roles && Array.isArray(user.roles) && user.roles.includes(SUPERADMIN_ROLE)) ||
    user.role === SUPERADMIN_ROLE;
  if (isSuperAdmin || !user.tenantId) {
    throw new ForbiddenException(NO_TENANT_MESSAGE);
  }
}

@Controller('customization')
@UseGuards(JwtAuthGuard)
export class CustomizationController {
  constructor(private readonly service: CustomizationService) {}

  @Get('tenant')
  async getCurrentTenantCustomization(@CurrentUser() user: AuthenticatedUser) {
    assertTenantScope(user);
    return this.service.getCustomization(user.tenantId);
  }

  @Get('tenant/:tenantId')
  @UseGuards(SuperAdminGuard)
  async getTenantCustomization(@Param('tenantId') tenantId: string) {
    return this.service.getCustomization(tenantId);
  }

  @Patch('tenant')
  async updateCurrentTenantCustomization(
    @Body() dto: CustomizationPatchInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    assertTenantScope(user);
    return this.service.updateCustomization(user.tenantId, dto, user);
  }

  @Patch('tenant/:tenantId')
  @UseGuards(SuperAdminGuard)
  async updateTenantCustomization(
    @Param('tenantId') tenantId: string,
    @Body() dto: CustomizationPatchInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.updateCustomization(tenantId, dto, user);
  }

  @Post('tenant/:tenantId/publish')
  @UseGuards(SuperAdminGuard)
  async publishTenantCustomization(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.publishCustomization(tenantId, user);
  }

  @Post('tenant/:tenantId/reset')
  @UseGuards(SuperAdminGuard)
  async resetTenantCustomization(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.resetCustomization(tenantId, user);
  }

  @Get('tenant/custom-fields')
  async listCurrentTenantCustomFields(
    @CurrentUser() user: AuthenticatedUser,
    @Query('entity') entity?: string,
  ) {
    assertTenantScope(user);
    return this.service.listCustomFields(user.tenantId, entity);
  }

  @Get('tenant/:tenantId/custom-fields')
  @UseGuards(SuperAdminGuard)
  async listTenantCustomFields(
    @Param('tenantId') tenantId: string,
    @Query('entity') entity?: string,
  ) {
    return this.service.listCustomFields(tenantId, entity);
  }

  @Get('tenant/custom-field-values/:entity/:recordId')
  async getCurrentTenantCustomFieldValues(
    @CurrentUser() user: AuthenticatedUser,
    @Param('entity') entity: string,
    @Param('recordId') recordId: string,
  ) {
    assertTenantScope(user);
    return this.service.getCustomFieldValues(user.tenantId, entity, recordId);
  }

  @Get('tenant/:tenantId/custom-field-values/:entity/:recordId')
  @UseGuards(SuperAdminGuard)
  async getTenantCustomFieldValues(
    @Param('tenantId') tenantId: string,
    @Param('entity') entity: string,
    @Param('recordId') recordId: string,
  ) {
    return this.service.getCustomFieldValues(tenantId, entity, recordId);
  }

  @Post('tenant/custom-field-values/:entity/:recordId')
  async upsertCurrentTenantCustomFieldValues(
    @CurrentUser() user: AuthenticatedUser,
    @Param('entity') entity: string,
    @Param('recordId') recordId: string,
    @Body() values: Record<string, unknown>,
  ) {
    assertTenantScope(user);
    return this.service.upsertCustomFieldValues(user.tenantId, entity, recordId, values);
  }

  @Post('tenant/:tenantId/custom-field-values/:entity/:recordId')
  @UseGuards(SuperAdminGuard)
  async upsertTenantCustomFieldValues(
    @Param('tenantId') tenantId: string,
    @Param('entity') entity: string,
    @Param('recordId') recordId: string,
    @Body() values: Record<string, unknown>,
  ) {
    return this.service.upsertCustomFieldValues(tenantId, entity, recordId, values);
  }

  @Post('tenant/custom-fields')
  async upsertCurrentTenantCustomField(
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    assertTenantScope(user);
    return this.service.upsertCustomField(user.tenantId, dto, user);
  }

  @Post('tenant/:tenantId/custom-fields')
  @UseGuards(SuperAdminGuard)
  async upsertTenantCustomField(
    @Param('tenantId') tenantId: string,
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.upsertCustomField(tenantId, dto, user);
  }

  @Post('tenant/custom-fields/:fieldId/delete')
  async deleteCurrentTenantCustomField(
    @Param('fieldId') fieldId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    assertTenantScope(user);
    return this.service.deleteCustomField(user.tenantId, fieldId, user);
  }

  @Post('tenant/:tenantId/custom-fields/:fieldId/delete')
  @UseGuards(SuperAdminGuard)
  async deleteTenantCustomField(
    @Param('tenantId') tenantId: string,
    @Param('fieldId') fieldId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.deleteCustomField(tenantId, fieldId, user);
  }
}
