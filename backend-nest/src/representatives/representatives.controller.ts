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
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
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
  CreateAndAssignCustomerDto,
  AssignCustomersDto,
  AssignProductsDto,
  CreateRepRouteDto,
  CreateRepShopDto,
  RepQueryDto,
  RepSaleQueryDto,
} from './dto/representatives.dto';

@Controller('representatives')
@UseGuards(JwtAuthGuard, PageAccessGuard)
@RequiresPage('reps.management')
export class RepresentativesController {
  constructor(private readonly reps: RepresentativesService) {}

  private requireAdmin(user: AuthenticatedUser) {
    const roles = Array.isArray(user.roles) ? user.roles : [];
    if (user.role !== 'admin' && user.role !== 'superadmin' && !roles.includes('admin') && !roles.includes('superadmin')) {
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

  /** الموظفون المرشحون ليصبحوا مندوبين (مندوب = موظف بخاصية مندوب) */
  @Get('employee-options')
  getEmployeeOptions(@CurrentUser() user: AuthenticatedUser) {
    this.requireAdmin(user);
    return this.reps.listEmployeeCandidates();
  }

  /** إنشاء عميل جديد وربطه بالمندوب من شاشة إدارة المندوب — قبل :repId */
  @Post(':repId/customers/create')
  createAndAssignCustomer(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateAndAssignCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.reps.createAndAssignCustomer(repId, dto);
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
    // الأدمن + المندوب صاحب السجل (عبر العزل) — الصفحة تحددها الـ guard أما
    // الدور فيُفحص هنا: أدمن يمر، مندوب يمر فقط لسجله.
    const roles = Array.isArray(user.roles) ? user.roles : [];
    const isAdmin =
      user.role === 'admin' ||
      user.role === 'superadmin' ||
      roles.includes('admin') ||
      roles.includes('superadmin');
    if (!isAdmin) {
      // ليس أدمن: اسمح فقط إن كان مندوباً — العزل الكامل يتم عبر
      // RepIsolationGuard على مسارات workspace، وهنا نسمح بقراءة تسوياته.
      const isRep = user.role === 'representative' || roles.includes('representative');
      if (!isRep) throw new ForbiddenException('هذه العملية للمسؤول فقط');
    }
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
  // Self workspace: gated by reps.workspace (not reps.management) so a rep
  // whose factory bought the workspace is not 403'd by the admin page key.
  // =========================================================================

  @Get('me/profile')
  @RequiresPage('reps.workspace')
  getMyProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.reps.getMyProfile(user.userId);
  }

  // =========================================================================
  // REP-SCOPED — My Route & Shops (خطي ومحلاتي)
  // =========================================================================

  @Get(':repId/routes')
  @RequiresPage('reps.workspace')
  @UseGuards(RepIsolationGuard)
  getMyRoutes(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.reps.getMyRoutes(repId);
  }

  @Post(':repId/route')
  @RequiresPage('reps.workspace')
  @UseGuards(RepIsolationGuard)
  createMyRoute(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateRepRouteDto,
  ) {
    return this.reps.createMyRoute(repId, dto);
  }

  @Get(':repId/shops')
  @RequiresPage('reps.workspace')
  @UseGuards(RepIsolationGuard)
  getMyShops(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.reps.getMyShops(repId);
  }

  @Post(':repId/shops')
  @RequiresPage('reps.workspace')
  @UseGuards(RepIsolationGuard)
  createMyShop(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateRepShopDto,
  ) {
    return this.reps.createMyShop(repId, dto);
  }

  // =========================================================================
  // REP-SCOPED — Stock & Movements (isolated by RepIsolationGuard)
  // =========================================================================

  @Get(':repId/stock')
  @RequiresPage('reps.workspace')
  @UseGuards(RepIsolationGuard)
  getStock(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.reps.getMyStock(repId);
  }

  @Get(':repId/movements')
  @RequiresPage('reps.workspace')
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
  @RequiresPage('reps.workspace')
  @UseGuards(RepIsolationGuard)
  createSale(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateRepSaleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reps.createSale(repId, dto, user.userId);
  }

  @Get(':repId/sales')
  @RequiresPage('reps.workspace')
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
  @RequiresPage('reps.workspace')
  @UseGuards(RepIsolationGuard)
  createCollection(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateRepCollectionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reps.createCollection(repId, dto, user.userId);
  }

  @Get(':repId/collections')
  @RequiresPage('reps.workspace')
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
  @RequiresPage('reps.workspace')
  @UseGuards(RepIsolationGuard)
  createReturn(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: CreateRepReturnDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reps.createReturn(repId, dto, user.userId);
  }

  @Get(':repId/returns')
  @RequiresPage('reps.workspace')
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
  @RequiresPage('reps.workspace')
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
  @RequiresPage('reps.workspace')
  @UseGuards(RepIsolationGuard)
  getSummary(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.reps.getRepSummary(repId);
  }
}
