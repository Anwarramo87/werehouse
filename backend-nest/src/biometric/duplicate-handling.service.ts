import { Injectable, Logger } from '@nestjs/common';

export enum DuplicateStrategy {
  KEEP_FIRST = 'keep_first',     // يحتفظ بالأول (الأقدم)
  KEEP_LAST = 'keep_last',       // يحتفظ بالأخير (الأحدث)
  KEEP_EARLIEST = 'keep_earliest', // للدخول: يحتفظ بالأبكر / للخروج: يحتفظ بالأخير
  AVERAGE = 'average',           // يأخذ متوسط الوقتين
}

interface DuplicateCheckResult {
  isDuplicate: boolean;
  existingRecord?: any;
  action: 'insert' | 'skip' | 'update';
  reason?: string;
}

@Injectable()
export class DuplicateHandlingService {
  private readonly logger = new Logger(DuplicateHandlingService.name);
  
  // يمكن تغييرها من .env
  private readonly strategy: DuplicateStrategy;
  private readonly duplicateWindowMinutes: number;

  constructor() {
    this.strategy = (process.env.BIOMETRIC_DUPLICATE_STRATEGY as DuplicateStrategy) || 
                    DuplicateStrategy.KEEP_EARLIEST;
    this.duplicateWindowMinutes = parseInt(process.env.BIOMETRIC_DUPLICATE_WINDOW_MINUTES || '5');
  }

  /**
   * 🎯 التحقق من التكرار وتحديد الإجراء
   */
  async checkDuplicate(
    employeeId: string,
    newTimestamp: Date,
    checkType: 'check-in' | 'check-out',
    existingRecords: any[],
  ): Promise<DuplicateCheckResult> {
    
    // 1. ابحث عن سجلات في نفس اليوم ونفس النوع
    const sameTypeRecords = existingRecords.filter(
      (record) => record.type === checkType
    );

    if (sameTypeRecords.length === 0) {
      return { isDuplicate: false, action: 'insert' };
    }

    // 2. ابحث عن سجلات ضمن نافذة التكرار (5 دقائق افتراضياً)
    const windowMs = this.duplicateWindowMinutes * 60 * 1000;
    const duplicates = sameTypeRecords.filter((record) => {
      const timeDiff = Math.abs(new Date(record.timestamp).getTime() - newTimestamp.getTime());
      return timeDiff <= windowMs;
    });

    if (duplicates.length === 0) {
      // ليس تكراراً - أكثر من 5 دقائق بين البصمات
      return { isDuplicate: false, action: 'insert' };
    }

    // 3. وجدنا تكرار! حدد الإجراء بناءً على الاستراتيجية
    const existingRecord = duplicates[0];
    const action = this.resolveAction(newTimestamp, existingRecord, checkType);

    return {
      isDuplicate: true,
      existingRecord,
      action,
      reason: this.explainAction(action, newTimestamp, existingRecord, checkType),
    };
  }

  /**
   * 🎯 تحديد الإجراء بناءً على الاستراتيجية
   */
  private resolveAction(
    newTimestamp: Date,
    existingRecord: any,
    checkType: 'check-in' | 'check-out',
  ): 'insert' | 'skip' | 'update' {
    
    const existingTime = new Date(existingRecord.timestamp);
    const newTime = newTimestamp;

    switch (this.strategy) {
      case DuplicateStrategy.KEEP_FIRST:
        // احتفظ بالأول دائماً
        return 'skip';

      case DuplicateStrategy.KEEP_LAST:
        // احتفظ بالأخير دائماً
        return 'update';

      case DuplicateStrategy.KEEP_EARLIEST:
        // للدخول: احتفظ بالأبكر (الأفضل للموظف)
        // للخروج: احتفظ بالأخير (الأفضل للموظف)
        if (checkType === 'check-in') {
          return newTime < existingTime ? 'update' : 'skip';
        } else {
          return newTime > existingTime ? 'update' : 'skip';
        }

      case DuplicateStrategy.AVERAGE:
        // خذ المتوسط
        return 'update';

      default:
        return 'skip';
    }
  }

  /**
   * 🎯 حساب متوسط الوقت (للاستراتيجية AVERAGE)
   */
  calculateAverageTime(time1: Date, time2: Date): Date {
    const avg = (time1.getTime() + time2.getTime()) / 2;
    return new Date(avg);
  }

  /**
   * 🎯 شرح الإجراء
   */
  private explainAction(
    action: string,
    newTimestamp: Date,
    existingRecord: any,
    checkType: string,
  ): string {
    const existingTime = new Date(existingRecord.timestamp);
    const newTime = newTimestamp;
    const diffMinutes = Math.abs(newTime.getTime() - existingTime.getTime()) / (1000 * 60);

    switch (action) {
      case 'skip':
        return `تم تخطي البصمة الجديدة. السجل الموجود في ${existingTime.toLocaleTimeString('ar-SY')} أفضل. (فرق ${diffMinutes.toFixed(1)} دقيقة)`;
      
      case 'update':
        return `تم تحديث الوقت من ${existingTime.toLocaleTimeString('ar-SY')} إلى ${newTime.toLocaleTimeString('ar-SY')}. (فرق ${diffMinutes.toFixed(1)} دقيقة)`;
      
      default:
        return 'سجل جديد';
    }
  }

  /**
   * 🎯 سجل التكرار للتدقيق
   */
  logDuplicateAttempt(
    employeeId: string,
    newTimestamp: Date,
    result: DuplicateCheckResult,
  ): void {
    if (!result.isDuplicate) return;

    this.logger.warn(
      `🔁 [تكرار] ${employeeId} - ${result.action.toUpperCase()} - ${result.reason}`
    );
  }

  /**
   * 🎯 إحصائيات التكرار
   */
  getDuplicateStats(): any {
    return {
      strategy: this.strategy,
      windowMinutes: this.duplicateWindowMinutes,
      description: this.getStrategyDescription(),
    };
  }

  private getStrategyDescription(): string {
    switch (this.strategy) {
      case DuplicateStrategy.KEEP_FIRST:
        return 'يحتفظ دائماً بأول بصمة ويتجاهل المحاولات اللاحقة';
      
      case DuplicateStrategy.KEEP_LAST:
        return 'يحتفظ دائماً بآخر بصمة ويحدّث السجل';
      
      case DuplicateStrategy.KEEP_EARLIEST:
        return 'للدخول: يحتفظ بالأبكر (لصالح الموظف) / للخروج: يحتفظ بالأخير (لصالح الموظف)';
      
      case DuplicateStrategy.AVERAGE:
        return 'يأخذ متوسط الوقتين';
      
      default:
        return 'غير معروف';
    }
  }
}
