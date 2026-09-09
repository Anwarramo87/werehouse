import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { AccountingService } from './accounting.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { SetAccountMappingDto } from './dto/set-account-mapping.dto';
import { JournalEntryQueryDto } from './dto/journal-entry-query.dto';

@ApiTags('accounting')
@ApiCookieAuth()
@Controller('accounting')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AccountingController {
  constructor(private readonly accountingService: AccountingService) {}

  // accounts
  // ------------------------------------------------------------ ledger mapping

  @Get('ledger-mapping')
  @Permissions('view_accounting')
  listMappings() {
    return this.accountingService.listMappings();
  }

  @Post('ledger-mapping')
  @Permissions('edit_accounting')
  setMapping(@Body() dto: SetAccountMappingDto) {
    return this.accountingService.setMapping(dto);
  }

  @Delete('ledger-mapping/:role')
  @Permissions('edit_accounting')
  removeMapping(@Param('role') role: string) {
    return this.accountingService.removeMapping(role);
  }

  /** Creates a starter chart and maps every role to it in one call. */
  @Post('ledger-mapping/seed-defaults')
  @Permissions('edit_accounting')
  seedLedgerDefaults() {
    return this.accountingService.seedLedgerDefaults();
  }

  /** The automatic entries a given invoice or count produced. */
  @Get('entries-for/:sourceType/:sourceId')
  @Permissions('view_accounting')
  entriesForSource(
    @Param('sourceType') sourceType: string,
    @Param('sourceId') sourceId: string,
  ) {
    return this.accountingService.entriesForSource(sourceType, sourceId);
  }

  @Get('accounts')
  @Permissions('view_accounting')
  listAccounts(@Query() query: { search?: string; type?: string; isActive?: string }) {
    return this.accountingService.listAccounts(query);
  }

  @Get('accounts/:accountId')
  @Permissions('view_accounting')
  getAccount(@Param('accountId') accountId: string) {
    return this.accountingService.getAccount(accountId);
  }

  @Post('accounts')
  @Permissions('edit_accounting')
  createAccount(@Body() dto: CreateAccountDto) {
    return this.accountingService.createAccount(dto);
  }

  @Put('accounts/:accountId')
  @Permissions('edit_accounting')
  updateAccount(@Param('accountId') accountId: string, @Body() dto: UpdateAccountDto) {
    return this.accountingService.updateAccount(accountId, dto);
  }

  @Delete('accounts/:accountId')
  @Permissions('edit_accounting')
  removeAccount(@Param('accountId') accountId: string) {
    return this.accountingService.removeAccount(accountId);
  }

  // journal entries
  @Get('journal-entries')
  @Permissions('view_accounting')
  listJournalEntries(@Query() query: JournalEntryQueryDto) {
    return this.accountingService.listJournalEntries(query);
  }

  @Get('journal-entries/:entryId')
  @Permissions('view_accounting')
  getJournalEntry(@Param('entryId') entryId: string) {
    return this.accountingService.getJournalEntry(entryId);
  }

  @Post('journal-entries')
  @Permissions('edit_accounting')
  createJournalEntry(@Body() dto: CreateJournalEntryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.accountingService.createJournalEntry(dto, user.userId);
  }

  // reports
  @Get('reports/trial-balance')
  @Permissions('view_accounting')
  trialBalance(@Query() query: { from?: string; to?: string }) {
    return this.accountingService.trialBalance(query);
  }

  @Get('reports/income-statement')
  @Permissions('view_accounting')
  incomeStatement(@Query() query: { from?: string; to?: string }) {
    return this.accountingService.incomeStatement(query);
  }

  @Get('reports/balance-sheet')
  @Permissions('view_accounting')
  balanceSheet(@Query() query: { asOf?: string }) {
    return this.accountingService.balanceSheet(query);
  }
}
