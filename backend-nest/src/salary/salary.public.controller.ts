import { Body, Controller, Post } from '@nestjs/common';
import { SalaryService } from './salary.service';
import { CalculateAllowancesDto } from './dto/calculate-allowances.dto';

/**
 * Temporary public endpoint for frontend/dev testing ONLY.
 * Not protected by auth; only enabled in non-production environments.
 */
@Controller('salary/public')
export class SalaryPublicController {
  constructor(private readonly salaryService: SalaryService) {}

  @Post('calculate-allowances')
  calculateAllowances(@Body() dto: CalculateAllowancesDto) {
    return this.salaryService.calculateAllowances(dto);
  }
}
