import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * RepIsolationGuard — الحارس الأمني الأساسي لنظام المندوبين
 *
 * القاعدة:
 *   - Admin/superadmin → يمر دائماً، يرى الجميع
 *   - مندوب → يُتحقق أن representativeId في الـURL يخصه فقط
 *     حتى لو غيّر الـID يدوياً في الـURL أو أرسل request مباشر،
 *     يُرفض الطلب بـ403
 *
 * الاستخدام:
 *   @UseGuards(JwtAuthGuard, RepIsolationGuard)
 *   على أي controller يتعامل مع /representatives/:repId/...
 */
@Injectable()
export class RepIsolationGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) throw new ForbiddenException('غير مصرح');

    // Admin و superadmin يمرون مباشرة
    if (user.role === 'admin' || user.role === 'superadmin') {
      return true;
    }

    // استخراج representativeId من params
    const repIdFromParams = request.params?.repId ?? request.params?.id;

    if (!repIdFromParams) {
      // لا يوجد repId في الـURL — ربما endpoint للقائمة العامة
      // نمنع المندوب من رؤية قائمة كل المندوبين
      if (user.role === 'representative') {
        throw new ForbiddenException(
          'المندوب لا يمكنه الوصول لهذا المسار دون تحديد معرّفه',
        );
      }
      return true;
    }

    // جلب سجل المندوب المرتبط بهذا المستخدم
    const rep = await this.prisma.representative.findUnique({
      where: { userId: user.userId },
      select: { id: true, status: true },
    });

    if (!rep) {
      throw new ForbiddenException('المستخدم ليس مندوباً مسجلاً');
    }

    if (rep.status !== 'active') {
      throw new ForbiddenException('حساب المندوب غير نشط');
    }

    // المقارنة الأمنية الحاسمة
    if (rep.id !== repIdFromParams) {
      throw new ForbiddenException(
        'لا يمكنك الوصول إلى بيانات مندوب آخر',
      );
    }

    // حقن representativeId في الـrequest لاستخدامه في الـservice
    request.representativeId = rep.id;
    return true;
  }
}
