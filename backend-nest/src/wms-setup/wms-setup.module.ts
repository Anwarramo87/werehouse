import { Module } from '@nestjs/common';
import { WmsSetupController } from './wms-setup.controller';
import { WmsSetupService } from './wms-setup.service';

@Module({
  controllers: [WmsSetupController],
  providers: [WmsSetupService],
  exports: [WmsSetupService],
})
export class WmsSetupModule {}
