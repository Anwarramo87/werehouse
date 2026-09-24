import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { PutawayStatus } from '@prisma/client';
import { LocationsService } from './locations.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { SubscriptionGuard } from '../common/entitlements/subscription.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';
import { CreateBinDto } from './dto/create-bin.dto';
import { UpdateBinDto } from './dto/update-bin.dto';
import { BulkCreateBinsDto } from './dto/bulk-create-bins.dto';
import { SuggestPutawayDto } from './dto/suggest-putaway.dto';
import { CompletePutawayDto } from './dto/complete-putaway.dto';

@ApiTags('locations')
@ApiCookieAuth()
@Controller('locations')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('inventory.locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  // -------------------------------------------------------------------- zones

  @Get('zones')
  @Permissions('view_inventory')
  listZones(@Query('warehouseId') warehouseId?: string) {
    return this.locations.listZones(warehouseId);
  }

  @Post('zones')
  @Permissions('edit_inventory')
  createZone(@Body() dto: CreateZoneDto) {
    return this.locations.createZone(dto);
  }

  @Put('zones/:zoneId')
  @Permissions('edit_inventory')
  updateZone(@Param('zoneId') zoneId: string, @Body() dto: UpdateZoneDto) {
    return this.locations.updateZone(zoneId, dto);
  }

  @Delete('zones/:zoneId')
  @Permissions('edit_inventory')
  deleteZone(@Param('zoneId') zoneId: string) {
    return this.locations.deleteZone(zoneId);
  }

  // --------------------------------------------------------------------- bins

  @Get('bins')
  @Permissions('view_inventory')
  listBins(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('zoneId') zoneId?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.locations.listBins({ page, limit, zoneId, search, status });
  }

  @Post('bins')
  @Permissions('edit_inventory')
  createBin(@Body() dto: CreateBinDto) {
    return this.locations.createBin(dto);
  }

  /** Generates a whole rack layout at once. */
  @Post('bins/bulk')
  @Permissions('edit_inventory')
  bulkCreateBins(@Body() dto: BulkCreateBinsDto) {
    return this.locations.bulkCreateBins(dto);
  }

  @Put('bins/:binId')
  @Permissions('edit_inventory')
  updateBin(@Param('binId') binId: string, @Body() dto: UpdateBinDto) {
    return this.locations.updateBin(binId, dto);
  }

  @Delete('bins/:binId')
  @Permissions('edit_inventory')
  deleteBin(@Param('binId') binId: string) {
    return this.locations.deleteBin(binId);
  }

  // ------------------------------------------------------------------ putaway

  @Post('putaway/suggest')
  @Permissions('view_inventory')
  suggest(@Body() dto: SuggestPutawayDto) {
    return this.locations.suggest(dto);
  }

  @Get('putaway/tasks')
  @Permissions('view_inventory')
  listTasks(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: PutawayStatus,
    @Query('assignedTo') assignedTo?: string,
  ) {
    return this.locations.listTasks({ page, limit, status, assignedTo });
  }

  @Post('putaway/tasks')
  @Permissions('edit_inventory')
  createTask(
    @Body()
    body: {
      sku: string;
      quantity: number;
      fromLocation: string;
      batchId?: string;
      goodsReceiptItemId?: string;
      assignedTo?: string;
    },
  ) {
    return this.locations.createTask(body);
  }

  @Post('putaway/tasks/:taskId/complete')
  @Permissions('edit_inventory')
  completeTask(
    @Param('taskId') taskId: string,
    @Body() dto: CompletePutawayDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.locations.completeTask(taskId, dto, user);
  }

  @Post('putaway/tasks/:taskId/cancel')
  @Permissions('edit_inventory')
  cancelTask(@Param('taskId') taskId: string, @Body() body: { reason?: string }) {
    return this.locations.cancelTask(taskId, body?.reason);
  }

  // ---------------------------------------------------------------- occupancy

  @Get('occupancy')
  @Permissions('view_inventory')
  occupancy(@Query('warehouseId') warehouseId?: string) {
    return this.locations.occupancy(warehouseId);
  }
}
