import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { TransportationService } from './transportation.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CreateBusDto } from './dto/create-bus.dto';
import { UpdateBusDto } from './dto/update-bus.dto';
import { AddPassengerDto } from './dto/add-passenger.dto';
import { CalculateDeductionsDto } from '../attendance/dto/calculate-deductions.dto';

@ApiTags('transportation')
@ApiCookieAuth()
@Controller('transportation')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TransportationController {
  constructor(private readonly transportationService: TransportationService) {}

  /** GET /api/transportation/summary */
  @Get('summary')
  @Permissions('view_employees')
  summary() {
    return this.transportationService.summary();
  }

  /** GET /api/transportation/buses */
  @Get('buses')
  @Permissions('view_employees')
  listBuses() {
    return this.transportationService.listBuses();
  }

  /** POST /api/transportation/buses */
  @Post('buses')
  @Permissions('edit_employees')
  createBus(@Body() dto: CreateBusDto) {
    return this.transportationService.createBus(dto);
  }

  /** GET /api/transportation/buses/:busId */
  @Get('buses/:busId')
  @Permissions('view_employees')
  getBus(@Param('busId') busId: string) {
    return this.transportationService.getBus(busId);
  }

  /** PUT /api/transportation/buses/:busId */
  @Put('buses/:busId')
  @Permissions('edit_employees')
  updateBus(@Param('busId') busId: string, @Body() dto: UpdateBusDto) {
    return this.transportationService.updateBus(busId, dto);
  }

  /** DELETE /api/transportation/buses/:busId */
  @Delete('buses/:busId')
  @Permissions('edit_employees')
  deleteBus(@Param('busId') busId: string) {
    return this.transportationService.deleteBus(busId);
  }

  /** GET /api/transportation/buses/:busId/passengers */
  @Get('buses/:busId/passengers')
  @Permissions('view_employees')
  listPassengers(@Param('busId') busId: string) {
    return this.transportationService.listPassengers(busId);
  }

  /** POST /api/transportation/buses/:busId/passengers */
  @Post('buses/:busId/passengers')
  @Permissions('edit_employees')
  addPassenger(@Param('busId') busId: string, @Body() dto: AddPassengerDto) {
    return this.transportationService.addPassenger(busId, dto);
  }

  /** DELETE /api/transportation/buses/:busId/passengers/:employeeId */
  @Delete('buses/:busId/passengers/:employeeId')
  @Permissions('edit_employees')
  removePassenger(
    @Param('busId') busId: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.transportationService.removePassenger(busId, employeeId);
  }

  /** POST /api/transportation/calculate-deductions */
  @Post('calculate-deductions')
  @Permissions('view_payroll')
  calculateDeductions(@Body() dto: CalculateDeductionsDto) {
    return this.transportationService.calculateDeductions(dto);
  }
}
