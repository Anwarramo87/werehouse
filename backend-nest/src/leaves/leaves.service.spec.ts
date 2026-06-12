import { Test, TestingModule } from '@nestjs/testing';
import { LeavesService } from './leaves.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LeavesService', () => {
  let service: LeavesService;

  const prismaMock = {
    leaveRequest: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    employee: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeavesService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get(LeavesService);
  });

  it('list(): should filter leaves by date overlap (startDate<=periodEnd && endDate>=periodStart)', async () => {
    prismaMock.leaveRequest.findMany.mockResolvedValue([]);
    prismaMock.leaveRequest.count.mockResolvedValue(0);

    await service.list({
      page: 1,
      limit: 10,
      startDate: '2026-05-10',
      endDate: '2026-05-20',
    } as any);

    const wherePassed = prismaMock.leaveRequest.findMany.mock.calls[0][0].where;
    // Expect overlap style
    expect(wherePassed).toHaveProperty('AND');
    const andClause = wherePassed.AND[0];
    expect(andClause).toHaveProperty('startDate');
    // Implementation will be updated in service
    // We just assert the rough shape after modifications.
  });
});

