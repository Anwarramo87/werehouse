import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { DiscountsService } from './discounts.service';
import { CreateDiscountDto, DiscountKind } from './dto/create-discount.dto';
import { DiscountsListQueryDto } from './dto/discounts-list-query.dto';

@ApiTags('penalties')
@ApiCookieAuth()
@Controller('discounts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DiscountsController {
  constructor(private readonly discountsService: DiscountsService) {}

  @Get()
  @Permissions('manage_advances', 'manage_bonuses')
  list(@Query() query: DiscountsListQueryDto) {
    return this.discountsService.list(query.employeeId, query.period);
  }

  @Post()
  @Permissions('manage_advances', 'manage_bonuses')
  create(@Body() dto: CreateDiscountDto, @CurrentUser() user: AuthenticatedUser) {
    const kind = this.resolveKind(dto);
    this.assertPermission(user, kind);
    return this.discountsService.create(dto, kind);
  }

  @Delete(':id')
  @Permissions('manage_advances', 'manage_bonuses', 'manage_penalties')
  remove(
    @Param('id') id: string,
    @Query('kind') kindParam: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const kind = kindParam ? this.parseKind(kindParam) : undefined;
    this.assertPermission(user, kind);
    return this.discountsService.remove(id, kind, user?.userId);
  }

  private resolveKind(dto: CreateDiscountDto): DiscountKind {
    if (dto.kind) return dto.kind;
    if (dto.type?.trim() === 'سلفة') return DiscountKind.ADVANCE;
    return DiscountKind.ASSISTANCE;
  }

  private parseKind(kindParam?: string): DiscountKind | 'penalty' {
    if (!kindParam) {
      throw new BadRequestException('kind is required');
    }

    if (kindParam === DiscountKind.ADVANCE) return DiscountKind.ADVANCE;
    if (kindParam === DiscountKind.ASSISTANCE) return DiscountKind.ASSISTANCE;
    if (kindParam === 'penalty') return 'penalty';

    throw new BadRequestException('Invalid kind value');
  }

  private assertPermission(user: AuthenticatedUser | undefined, kind: DiscountKind | 'penalty' | undefined) {
    if (!kind) return;

    const permissions = user?.permissions || [];
    const roles = user?.roles || [];

    if (roles.includes('admin') || user?.role === 'admin') {
      return;
    }

    if (kind === 'penalty') {
      if (!permissions.includes('manage_penalties')) {
        throw new ForbiddenException('Insufficient permissions for this operation');
      }
      return;
    }

    const required = kind === DiscountKind.ADVANCE ? 'manage_advances' : 'manage_bonuses';
    if (!permissions.includes(required)) {
      throw new ForbiddenException('Insufficient permissions for this operation');
    }
  }
}
