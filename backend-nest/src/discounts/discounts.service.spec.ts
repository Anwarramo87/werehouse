import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DiscountsService } from './discounts.service';
import { AdvancesService } from '../advances/advances.service';
import { BonusesService } from '../bonuses/bonuses.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { DiscountKind } from './dto/create-discount.dto';

describe('DiscountsService', () => {
  let service: DiscountsService;
  let bonusesService: { create: jest.Mock };

  beforeEach(async () => {
    bonusesService = {
      create: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscountsService,
        {
          provide: AdvancesService,
          useValue: {
            list: jest.fn(),
            create: jest.fn(),
            getById: jest.fn(),
            remove: jest.fn(),
          },
        },
        { provide: BonusesService, useValue: bonusesService },
        {
          provide: ShortCacheService,
          useValue: {
            invalidatePrefix: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(DiscountsService);
  });

  it('throws when bonuses service reports that no bonus record was created', async () => {
    bonusesService.create.mockResolvedValue({
      message: 'Salary increased successfully',
      skipBonusRecord: true,
    });

    await expect(
      service.create(
        {
          employeeId: 'E1',
          amount: 100,
          notes: 'خصم',
          date: '2026-01-01',
        } as any,
        DiscountKind.ASSISTANCE,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
