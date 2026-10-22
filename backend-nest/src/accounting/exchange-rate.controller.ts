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
import { ExchangeRateService } from './exchange-rate.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {
  PERM_MANAGE_EXCHANGE_RATES,
  PERM_VIEW_ACCOUNTING,
} from '../common/permissions/permission.constants';

class AddExchangeRateDto {
  @IsString()
  pair: string;

  @IsNumber()
  @Min(0.0001)
  @Type(() => Number)
  rate: number;

  @IsDateString()
  rateDate: string;
}

class UpdateExchangeRateDto {
  @IsNumber()
  @Min(0.0001)
  @Type(() => Number)
  rate: number;

  @IsString()
  @IsOptional()
  reason?: string;
}

/**
 * سجل أسعار الصرف — the daily archived exchange-rate book.
 *
 * Reading it is an accounting read (every accountant needs to see the rate
 * that priced an invoice). Writing it is a separate, tighter permission: a
 * rate that prices money must not be editable by everyone who can post a
 * journal entry, and the two are separated here exactly as the brief asks.
 */
@ApiTags('exchange-rates')
@ApiCookieAuth()
@Controller('accounting/exchange-rates')
@UseGuards(JwtAuthGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('accounting.exchange-rates')
export class ExchangeRateController {
  constructor(private readonly exchangeRates: ExchangeRateService) {}

  @Get()
  @Permissions(PERM_VIEW_ACCOUNTING)
  list(@Query() query: { pair?: string; from?: string; to?: string }) {
    return this.exchangeRates.listRates(query);
  }

  @Post()
  @Permissions(PERM_MANAGE_EXCHANGE_RATES)
  add(
    @Body() dto: AddExchangeRateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.exchangeRates.addRate({
      pair: dto.pair,
      rate: dto.rate,
      rateDate: dto.rateDate,
      createdBy: user.userId,
    });
  }

  @Put(':id')
  @Permissions(PERM_MANAGE_EXCHANGE_RATES)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExchangeRateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.exchangeRates.updateRate(id, {
      rate: dto.rate,
      actorId: user.userId,
      reason: dto.reason,
    });
  }

  @Delete(':id')
  @Permissions(PERM_MANAGE_EXCHANGE_RATES)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.exchangeRates.removeRate(id, user.userId);
  }
}
