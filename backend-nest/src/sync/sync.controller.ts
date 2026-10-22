import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SyncService } from './sync.service';

@ApiTags('sync')
@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('status')
  @ApiOperation({ summary: 'حالة المزامنة بين قاعدة المصنع المحلية والسحابة' })
  status() {
    return this.sync.getStatus();
  }

  @Post('run')
  @HttpCode(200)
  @ApiOperation({ summary: 'تشغيل المزامنة الآن يدوياً' })
  async run() {
    const result = await this.sync.runNow();
    return { status: this.sync.getStatus(), result };
  }
}
