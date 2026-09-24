import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface UpdateSettingsDto {
  currency?: string;
  currencySymbol?: string;
  currencyDecimals?: number;
  locale?: string;
  timezone?: string;
  textDirection?: string;
  settings?: Record<string, unknown>;
}

const DEFAULT_SETTINGS = {
  currency: 'SYP',
  currencySymbol: 'ل.س',
  currencyDecimals: 0,
  locale: 'ar-SY',
  timezone: 'Asia/Damascus',
  textDirection: 'rtl',
  settings: {},
};

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** جلب إعدادات النظام — ينشئها إذا لم تكن موجودة */
  async getSettings(tenantId: string) {
    let settings = await this.prisma.systemSettings.findUnique({
      where: { tenantId },
    });
    if (!settings) {
      settings = await this.prisma.systemSettings.create({
        data: { tenantId, ...DEFAULT_SETTINGS },
      });
    }
    return settings;
  }

  /** تحديث الإعدادات */
  async updateSettings(tenantId: string, dto: UpdateSettingsDto) {
    const existing = await this.getSettings(tenantId);

    return this.prisma.systemSettings.update({
      where: { tenantId },
      data: {
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.currencySymbol !== undefined && { currencySymbol: dto.currencySymbol }),
        ...(dto.currencyDecimals !== undefined && { currencyDecimals: dto.currencyDecimals }),
        ...(dto.locale !== undefined && { locale: dto.locale }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        ...(dto.textDirection !== undefined && { textDirection: dto.textDirection }),
        ...(dto.settings !== undefined && {
          settings: { ...(existing.settings as object), ...dto.settings } as Prisma.InputJsonValue,
        }),
      },
    });
  }
}
