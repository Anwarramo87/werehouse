import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FilesService } from './files.service';

describe('FilesService', () => {
  let service: FilesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FilesService],
    }).compile();

    service = module.get(FilesService);
  });

  const makeFile = (overrides: Partial<Express.Multer.File> = {}): Express.Multer.File =>
    ({
      originalname: 'report.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('pdf-content'),
      size: 11,
      fieldname: 'file',
      encoding: '7bit',
      stream: null as never,
      destination: '',
      filename: '',
      path: '',
      ...overrides,
    });

  describe('uploadGeneralFile — validation', () => {
    it('throws BadRequestException when file buffer is empty', async () => {
      await expect(
        service.uploadGeneralFile(makeFile({ buffer: Buffer.alloc(0), size: 0 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException for unsupported extension', async () => {
      await expect(
        service.uploadGeneralFile(makeFile({ originalname: 'virus.exe', mimetype: 'application/octet-stream' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when MIME type does not match extension', async () => {
      await expect(
        service.uploadGeneralFile(
          makeFile({ originalname: 'image.png', mimetype: 'application/pdf' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts generic octet-stream MIME type for any allowed extension', async () => {
      // octet-stream is in GENERIC_MIME_TYPES so validation passes — upload succeeds
      const result = await service.uploadGeneralFile(
        makeFile({ originalname: 'doc.pdf', mimetype: 'application/octet-stream' }),
      );
      expect(result.file.mimeType).toBe('application/octet-stream');
    });
  });

  describe('listGeneralFiles — pagination', () => {
    it('returns empty list when upload directory does not exist', async () => {
      // Use a service instance pointing at a non-existent path
      const isolated = new (FilesService as new () => FilesService)();
      // Override uploadRoot to a guaranteed non-existent path
      (isolated as unknown as { uploadRoot: string }).uploadRoot = '/non/existent/path/xyz';
      const result = await isolated.listGeneralFiles(1, 20);
      expect(result.files).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });

    it('clamps limit to 100 maximum', async () => {
      const result = await service.listGeneralFiles(1, 9999);
      expect(result.pagination.limit).toBe(100);
    });

    it('clamps limit to 1 minimum', async () => {
      const result = await service.listGeneralFiles(1, 0);
      expect(result.pagination.limit).toBe(1);
    });

    it('defaults page to 1 for invalid input', async () => {
      const result = await service.listGeneralFiles(-5, 10);
      expect(result.pagination.page).toBe(1);
    });
  });
});
