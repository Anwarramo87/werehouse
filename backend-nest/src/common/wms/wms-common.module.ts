import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BarcodeService } from './barcode.service';
import { CostingService } from './costing.service';
import { DocumentNumberService } from './document-number.service';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { LedgerPostingService } from './ledger-posting.service';

/**
 * Cross-cutting warehouse services.
 *
 * Global because every WMS module needs at least two of the three, and
 * threading them through nine sets of module imports adds noise without
 * adding isolation — these are stateless helpers, not domain owners.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    BarcodeService,
    CostingService,
    DocumentNumberService,
    WebhookDispatchService,
    LedgerPostingService,
  ],
  exports: [
    BarcodeService,
    CostingService,
    DocumentNumberService,
    WebhookDispatchService,
    LedgerPostingService,
  ],
})
export class WmsCommonModule {}
