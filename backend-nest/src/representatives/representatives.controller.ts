import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ForbiddenException,
} from '@nestjs/common';
import { RepresentativesService } from './representatives.service';
import { RepIsolationGuard } from './guards/rep-isolation.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import {
  CreateRepresentativeDto,
  UpdateRepresentativeDto,
  TransferStockToRepDto,
  TransferStockFromRepDto,
  CreateRepSaleDto,
  CreateRepCollectionDto,
  CreateRepReturnDto,
  CreateSettlementDto,
  AssignCustomersDto,
  AssignProductsDto,
  CreateRepRouteDto,
  RepQueryDto,
  RepSaleQueryDto,
} from './dto/representatives.dto';

@Controller('representatives')
@UseGuards(JwtAuthGuard)
export class RepresentativesController {
  constructor(private readonly reps: RepresentativesService) {}

  private requireAdmin(user: AuthenticatedUser) {
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      throw new ForbiddenException('هذه العملية للمسؤول فقط');
    }
  }

  // =========================================================================
  // ADMIN — CRUD
  // =========================================================================

  @Post()
  create(@Body() dto: CreateRepresentativeDto, @CurrentUser() user: AuthenticatedUser) {
    this.requireAdmin(user);
    return this.reps.createRepresentative(dto, user.userId);
  }

  @Get()
  list(@Query() query: RepQueryDto, @CurrentUser() user: AuthenticatedUser) {
    this.requireAdmin(user);
    return this.reps.listRepresentatives(query);
  }

  @Get(':repId')
  getOne(
    @Param('repId', ParseUUIDPipe) repId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.getRepresentative(repId);
  }

  @Patch(':repId')
  update(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: UpdateRepresentativeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.updateRepresentative(repId, dto);
  }

  // =========================================================================
  // ADMIN — Assignments
  // =========================================================================

  @Post(':repId/customers')
  assignCustomers(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: AssignCustomersDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.assignCustomers(repId, dto);
  }

  @Post(':repId/products')
  assignProducts(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: AssignProductsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.assignProducts(repId, dto);
  }

  @Post(':repId/routes')
  assignRoute(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateRepRouteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.assignRoute(repId, dto);
  }

  @Post(':repId/transfer')
  transferStock(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: TransferStockToRepDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.transferStockToRep(repId, dto, user.userId);
  }

  @Post(':repId/transfer-back')
  transferBackStock(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: TransferStockFromRepDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.transferStockFromRep(repId, dto, user.userId);
  }

  @Get(':repId/settlements')
  getSettlements(
    @Param('repId', ParseUUIDPipe) repId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.getRepSettlements(repId);
  }

  @Patch('settlements/:id/approve')
  approveSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { approved?: boolean; notes?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.approveSettlement(id, body.approved ?? true, body.notes, user.userId);
  }

  // =========================================================================
  // REP-SCOPED — My profile (no repId in URL, uses JWT userId)
  // =========================================================================

  @Get('me/profile')
  getMyProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.reps.getMyProfile(user.userId);
  }

  // =========================================================================
  // REP-SCOPED — Stock & Movements (isolated by RepIsolationGuard)
  // =========================================================================

  @Get(':repId/stock')
  @UseGuards(RepIsolationGuard)
  getStock(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.reps.getMyStock(repId);
  }

  @Get(':repId/movements')
  @UseGuards(RepIsolationGuard)
  getMovements(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Query() query: RepSaleQueryDto,
  ) {
    return this.reps.getMyStockMovements(repId, query);
  }

  // =========================================================================
  // REP-SCOPED — Sales
  // =========================================================================

  @Post(':repId/sales')
  @UseGuards(RepIsolationGuard)
  createSale(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateRepSaleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reps.createSale(repId, dto, user.userId);
  }

  @Get(':repId/sales')
  @UseGuards(RepIsolationGuard)
  getSales(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Query() query: RepSaleQueryDto,
  ) {
    return this.reps.getMySales(repId, query);
  }

  // =========================================================================
  // REP-SCOPED — Collections
  // =========================================================================

  @Post(':repId/collections')
  @UseGuards(RepIsolationGuard)
  createCollection(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateRepCollectionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reps.createCollection(repId, dto, user.userId);
  }

  @Get(':repId/collections')
  @UseGuards(RepIsolationGuard)
  getCollections(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Query() query: RepSaleQueryDto,
  ) {
    return this.reps.getMyCollections(repId, query);
  }

  // =========================================================================
  // REP-SCOPED — Returns
  // =========================================================================

  @Post(':repId/returns')
  @UseGuards(RepIsolationGuard)
  createReturn(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateRepReturnDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reps.createReturn(repId, dto, user.userId);
  }

  @Get(':repId/returns')
  @UseGuards(RepIsolationGuard)
  getReturns(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Query() query: RepSaleQueryDto,
  ) {
    return this.reps.getMyReturns(repId, query);
  }

  // =========================================================================
  // REP-SCOPED — Settlement
  // =========================================================================

  @Post(':repId/settlement')
  @UseGuards(RepIsolationGuard)
  createSettlement(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reps.createSettlement(repId, dto, user.userId);
  }

  // =========================================================================
  // REP-SCOPED — Summary
  // =========================================================================

  @Get(':repId/summary')
  @UseGuards(RepIsolationGuard)
  getSummary(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.reps.getRepSummary(repId);
  }
}
