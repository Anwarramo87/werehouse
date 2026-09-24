import { Module } from '@nestjs/common';
import { RepresentativesController } from './representatives.controller';
import { RepresentativesService } from './representatives.service';
import { RepIsolationGuard } from './guards/rep-isolation.guard';

@Module({
  controllers: [RepresentativesController],
  providers: [RepresentativesService, RepIsolationGuard],
  exports: [RepresentativesService],
})
export class RepresentativesModule {}
