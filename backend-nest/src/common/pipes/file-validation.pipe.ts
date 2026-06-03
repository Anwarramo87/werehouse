import { Injectable, PipeTransform, BadRequestException } from '@nestjs/common';

export const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls
  'application/vnd.oasis.opendocument.spreadsheet',                    // .ods
  'application/json',
]);

export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface UploadedFileInfo {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  path?: string;
}

/**
 * FileValidationPipe
 * يتحقق من:
 *  - حجم الملف لا يتجاوز MAX_UPLOAD_SIZE_BYTES (10 MB)
 *  - نوع الـ MIME مدرج في القائمة البيضاء
 *
 * الاستخدام:
 *  @UploadedFile(new FileValidationPipe()) file: Express.Multer.File
 */
@Injectable()
export class FileValidationPipe implements PipeTransform {
  transform(file: UploadedFileInfo | undefined) {
    if (!file) {
      throw new BadRequestException('لم يتم رفع أي ملف');
    }

    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      throw new BadRequestException(
        `حجم الملف (${Math.round(file.size / 1024 / 1024)} MB) يتجاوز الحد الأقصى المسموح (10 MB)`,
      );
    }

    if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `نوع الملف "${file.mimetype}" غير مدعوم. الأنواع المسموحة: CSV, Excel (xlsx/xls), ODS, JSON`,
      );
    }

    return file;
  }
}

/**
 * multer limits config — يُستخدم في @UseInterceptors(FileInterceptor('file', multerLimits))
 */
export const multerFileLimits = {
  fileSize: MAX_UPLOAD_SIZE_BYTES,
  files: 1,
};
