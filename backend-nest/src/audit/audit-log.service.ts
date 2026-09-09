import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditListQueryDto } from './dto/audit-list-query.dto';

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditListQueryDto) {
    const {
      page,
      limit,
      action,
      actorId,
      targetType,
      targetId,
      startDate,
      endDate,
      search,
      sortBy,
      sortOrder,
    } = query;

    const where: Prisma.AuditLogWhereInput = {};

    if (action) where.action = { contains: action, mode: 'insensitive' };
    if (actorId) where.actorId = { contains: actorId, mode: 'insensitive' };
    if (targetType) where.targetType = { contains: targetType, mode: 'insensitive' };
    if (targetId) where.targetId = targetId;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    if (search) {
      where.OR = [
        { actorUsername: { contains: search, mode: 'insensitive' } },
        { action: { contains: search, mode: 'insensitive' } },
        { targetType: { contains: search, mode: 'insensitive' } },
        { targetId: { contains: search, mode: 'insensitive' } },
      ];
    }

    const orderBy: Prisma.AuditLogOrderByWithRelationInput = {};
    const sortField = sortBy === 'timestamp' ? 'createdAt' : sortBy;
    orderBy[sortField as keyof Prisma.AuditLogOrderByWithRelationInput] =
      sortOrder === 'desc' ? 'desc' : 'asc';

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      success: true,
      auditLogs: rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}