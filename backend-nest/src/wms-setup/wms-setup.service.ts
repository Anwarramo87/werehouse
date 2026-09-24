import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// الخطوات الثماني للـSetup Wizard
export const WMS_SETUP_STEPS = {
  1: { key: 'warehouse', label: 'إعداد المخزن', required: true },
  2: { key: 'rawMaterials', label: 'إضافة المواد الخام', required: true },
  3: { key: 'finishedProducts', label: 'إنشاء المنتج النهائي', required: true },
  4: { key: 'bom', label: 'تحديد BOM', required: true },
  5: { key: 'productionCost', label: 'حساب تكلفة الإنتاج', required: false },
  6: { key: 'pricing', label: 'تحديد سعر البيع والربح', required: true },
  7: { key: 'review', label: 'مراجعة الإعداد', required: false },
  8: { key: 'complete', label: 'دخول WMS', required: false },
} as const;

export const TOTAL_STEPS = 8;

@Injectable()
export class WmsSetupService {
  constructor(private readonly prisma: PrismaService) {}

  /** جلب حالة الـSetup للـtenant الحالي */
  async getState(tenantId: string) {
    let state = await this.prisma.wmsSetupState.findUnique({
      where: { tenantId },
    });

    // إنشاء حالة جديدة إذا لم تكن موجودة
    if (!state) {
      // فحص إذا كانت البيانات موجودة مسبقاً
      const precheck = await this.prefillFromExistingData(tenantId);
      state = await this.prisma.wmsSetupState.create({
        data: {
          tenantId,
          currentStep: precheck.suggestedStep,
          stepsData: precheck.stepsData as object,
          isCompleted: false,
        },
      });
    }

    return {
      ...state,
      steps: this.buildStepsStatus(state.stepsData as Record<string, unknown>),
      totalSteps: TOTAL_STEPS,
    };
  }

  /** حفظ بيانات خطوة معينة والانتقال للتالية */
  async saveStep(
    tenantId: string,
    step: number,
    data: Record<string, unknown>,
  ) {
    if (step < 1 || step > TOTAL_STEPS) {
      throw new BadRequestException(`الخطوة يجب أن تكون بين 1 و ${TOTAL_STEPS}`);
    }

    const state = await this.getOrCreateState(tenantId);

    // التحقق من أن الخطوة لا تتجاوز الخطوة الحالية + 1
    if (step > state.currentStep + 1) {
      throw new BadRequestException(
        `لا يمكن تخطي الخطوات. الخطوة الحالية: ${state.currentStep}`,
      );
    }

    // التحقق من البيانات المطلوبة للخطوة
    await this.validateStepData(tenantId, step, data);

    const stepsData = (state.stepsData as Record<string, unknown>) ?? {};
    const stepKey = WMS_SETUP_STEPS[step as keyof typeof WMS_SETUP_STEPS]?.key;
    stepsData[`step${step}`] = { ...data, completedAt: new Date().toISOString() };

    const nextStep = Math.min(step + 1, TOTAL_STEPS);
    const isCompleted = step === TOTAL_STEPS;

    const updated = await this.prisma.wmsSetupState.update({
      where: { tenantId },
      data: {
        currentStep: Math.max(state.currentStep, nextStep),
        stepsData: stepsData as object,
        isCompleted,
        completedAt: isCompleted ? new Date() : null,
      },
    });

    return {
      ...updated,
      steps: this.buildStepsStatus(updated.stepsData as Record<string, unknown>),
      totalSteps: TOTAL_STEPS,
      justCompleted: isCompleted,
      nextStep: isCompleted ? null : nextStep,
      stepKey,
    };
  }

  /** الانتقال لخطوة سابقة (للتعديل) */
  async goToStep(tenantId: string, step: number) {
    if (step < 1 || step > TOTAL_STEPS) {
      throw new BadRequestException(`الخطوة يجب أن تكون بين 1 و ${TOTAL_STEPS}`);
    }

    const state = await this.getOrCreateState(tenantId);

    // لا يمكن الذهاب لخطوة أمام الخطوة الحالية إلا إذا كانت مكتملة مسبقاً
    if (step > state.currentStep) {
      throw new BadRequestException('لا يمكن الانتقال لخطوة لم تُكمل بعد');
    }

    const updated = await this.prisma.wmsSetupState.update({
      where: { tenantId },
      data: { currentStep: step },
    });

    return {
      ...updated,
      steps: this.buildStepsStatus(updated.stepsData as Record<string, unknown>),
      totalSteps: TOTAL_STEPS,
    };
  }

  /** إكمال الـSetup */
  async completeSetup(tenantId: string) {
    const state = await this.getOrCreateState(tenantId);

    // التحقق من اكتمال الخطوات الإلزامية
    const stepsData = (state.stepsData as Record<string, unknown>) ?? {};
    const requiredSteps = Object.entries(WMS_SETUP_STEPS)
      .filter(([, v]) => v.required)
      .map(([k]) => Number(k));

    const missingSteps = requiredSteps.filter(
      (s) => !stepsData[`step${s}`],
    );
    if (missingSteps.length > 0) {
      throw new BadRequestException(
        `الخطوات التالية إلزامية ولم تكتمل: ${missingSteps.map((s) => WMS_SETUP_STEPS[s as keyof typeof WMS_SETUP_STEPS].label).join(', ')}`,
      );
    }

    return this.prisma.wmsSetupState.update({
      where: { tenantId },
      data: {
        isCompleted: true,
        completedAt: new Date(),
        currentStep: TOTAL_STEPS,
      },
    });
  }

  /** فحص هل الـSetup مكتمل */
  async isCompleted(tenantId: string): Promise<boolean> {
    const state = await this.prisma.wmsSetupState.findUnique({
      where: { tenantId },
      select: { isCompleted: true },
    });
    return state?.isCompleted ?? false;
  }

  /** إعادة تعيين الـSetup (للـAdmin فقط) */
  async resetSetup(tenantId: string) {
    return this.prisma.wmsSetupState.upsert({
      where: { tenantId },
      update: {
        currentStep: 1,
        stepsData: {},
        isCompleted: false,
        completedAt: null,
      },
      create: {
        tenantId,
        currentStep: 1,
        stepsData: {},
        isCompleted: false,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async getOrCreateState(tenantId: string) {
    let state = await this.prisma.wmsSetupState.findUnique({ where: { tenantId } });
    if (!state) {
      state = await this.prisma.wmsSetupState.create({
        data: { tenantId, currentStep: 1, stepsData: {}, isCompleted: false },
      });
    }
    return state;
  }

  /** فحص البيانات الموجودة مسبقاً لتخطي الخطوات المكتملة */
  private async prefillFromExistingData(tenantId: string) {
    const stepsData: Record<string, unknown> = {};
    let suggestedStep = 1;

    // الخطوة 1: هل يوجد مخزن؟
    const warehouseCount = await this.prisma.warehouse.count();
    if (warehouseCount > 0) {
      stepsData['step1'] = { prefilled: true, completedAt: new Date().toISOString() };
      suggestedStep = 2;
    }

    // الخطوة 2: هل توجد مواد خام؟
    const rawMaterialCount = await this.prisma.product.count({
      where: { productType: 'RAW_MATERIAL' },
    });
    if (rawMaterialCount > 0 && suggestedStep >= 2) {
      stepsData['step2'] = { prefilled: true, completedAt: new Date().toISOString() };
      suggestedStep = 3;
    }

    // الخطوة 3: هل يوجد منتج نهائي؟
    const finishedCount = await this.prisma.product.count({
      where: { productType: 'FINISHED' },
    });
    if (finishedCount > 0 && suggestedStep >= 3) {
      stepsData['step3'] = { prefilled: true, completedAt: new Date().toISOString() };
      suggestedStep = 4;
    }

    // الخطوة 4: هل توجد BOM نشطة؟
    const bomCount = await this.prisma.bOM.count({ where: { isActive: true } });
    if (bomCount > 0 && suggestedStep >= 4) {
      stepsData['step4'] = { prefilled: true, completedAt: new Date().toISOString() };
      suggestedStep = 5;
    }

    return { stepsData, suggestedStep };
  }

  /** التحقق من صحة بيانات كل خطوة */
  private async validateStepData(
    tenantId: string,
    step: number,
    data: Record<string, unknown>,
  ) {
    switch (step) {
      case 1: {
        // التحقق من وجود مخزن
        const count = await this.prisma.warehouse.count();
        if (count === 0 && !data['warehouseId']) {
          throw new BadRequestException('يجب إنشاء مخزن واحد على الأقل قبل المتابعة');
        }
        break;
      }
      case 2: {
        // التحقق من وجود مواد خام
        const count = await this.prisma.product.count({
          where: { productType: 'RAW_MATERIAL' },
        });
        if (count === 0) {
          throw new BadRequestException('يجب إضافة مادة خام واحدة على الأقل');
        }
        break;
      }
      case 3: {
        // التحقق من وجود منتج نهائي
        const count = await this.prisma.product.count({
          where: { productType: 'FINISHED' },
        });
        if (count === 0) {
          throw new BadRequestException('يجب إنشاء منتج نهائي واحد على الأقل');
        }
        break;
      }
      case 4: {
        // التحقق من وجود BOM
        const count = await this.prisma.bOM.count({ where: { isActive: true } });
        if (count === 0) {
          throw new BadRequestException('يجب إنشاء BOM واحدة على الأقل');
        }
        break;
      }
      case 6: {
        // التحقق من وجود سعر بيع
        const count = await this.prisma.product.count({
          where: { productType: 'FINISHED', unitPrice: { gt: 0 } },
        });
        if (count === 0) {
          throw new BadRequestException('يجب تحديد سعر بيع لمنتج نهائي واحد على الأقل');
        }
        break;
      }
    }
  }

  /** بناء حالة كل خطوة للعرض في الـFrontend */
  private buildStepsStatus(stepsData: Record<string, unknown>) {
    return Object.entries(WMS_SETUP_STEPS).map(([num, meta]) => {
      const stepNum = Number(num);
      const stepData = stepsData?.[`step${stepNum}`] as Record<string, unknown> | undefined;
      return {
        step: stepNum,
        key: meta.key,
        label: meta.label,
        required: meta.required,
        completed: !!stepData,
        completedAt: stepData?.completedAt ?? null,
        prefilled: stepData?.prefilled === true,
      };
    });
  }
}
