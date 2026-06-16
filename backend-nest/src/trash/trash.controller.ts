import { Controller, Delete, Get, Param, Post, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { TrashService } from './trash.service';

@ApiTags('trash')
@ApiCookieAuth()
@Controller('trash')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TrashController {
  constructor(private readonly trashService: TrashService) {}

  @Get()
  @Permissions('manage_trash')
  list(
    @Query() query: {
      entityType?: string;
      page?: number;
      limit?: number;
      fromDate?: string;
      toDate?: string;
    },
  ) {
    return this.trashService.list(query);
  }

  @Get('types')
  @Permissions('manage_trash')
  getTypes() {
    return this.trashService.getTypes();
  }

  @Post('restore/:historyId')
  @Permissions('manage_trash')
  restore(
    @Param('historyId', ParseUUIDPipe) historyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.trashService.restore(historyId, user?.userId);
  }

  @Delete(':historyId/permanent')
  @Permissions('manage_trash')
  permanentDelete(@Param('historyId', ParseUUIDPipe) historyId: string) {
    return this.trashService.permanentDelete(historyId);
  }
}
