import { Controller, Post, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { BiometricService } from './biometric.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';

@ApiTags('biometric')
@ApiCookieAuth()
@Controller('biometric')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BiometricController {
  constructor(private readonly biometricService: BiometricService) {}

  /**
   * 🎯 PHASE 4: Manual Sync Trigger Endpoint
   */
  @Post('trigger-sync')
  @Permissions('edit_attendance')
  @ApiOperation({
    summary: 'Trigger biometric attendance synchronization',
    description: 'Fetches logs from ZKTeco device (or simulator) and syncs to database',
  })
  async triggerSync() {
    return this.biometricService.synchronizeAttendance();
  }

  /**
   * 🎯 Device Status Check
   */
  @Get('status')
  @Permissions('view_attendance')
  @ApiOperation({
    summary: 'Check biometric device connection status',
  })
  async getStatus() {
    return this.biometricService.getDeviceStatus();
  }

  /**
   * 🎯 Get Duplicate Handling Configuration
   */
  @Get('duplicate-config')
  @Permissions('view_attendance')
  @ApiOperation({
    summary: 'Get current duplicate handling strategy',
  })
  async getDuplicateConfig() {
    return this.biometricService.getDuplicateConfig();
  }
}
