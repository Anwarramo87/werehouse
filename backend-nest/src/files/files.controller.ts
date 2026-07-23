import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { GENERAL_FILE_EXTENSIONS, FilesService } from './files.service';
import { FilesListQueryDto } from './dto/files-list-query.dto';

@ApiTags('files')
@ApiCookieAuth()
@Controller('files')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Get()
  @Permissions('run_imports')
  list(@Query() query: FilesListQueryDto) {
    return this.filesService.listGeneralFiles(query.page ?? 1, query.limit ?? 20);
  }

  private static readonly uploadOptions = {
    fileFilter: (
      _req: Request,
      file: Express.Multer.File,
      cb: (error: Error | null, acceptFile: boolean) => void,
    ) => {
      const originalName = String(file?.originalname || '').toLowerCase();
      const hasAllowedExtension = GENERAL_FILE_EXTENSIONS.some((extension) =>
        originalName.endsWith(extension),
      );

      if (!hasAllowedExtension) {
        cb(
          new BadRequestException(
            `Unsupported file type. Allowed extensions: ${GENERAL_FILE_EXTENSIONS.join(', ')}`,
          ) as unknown as Error,
          false,
        );
        return;
      }

      cb(null, true);
    },
    limits: {
      fileSize: 15 * 1024 * 1024,
    },
  };

  @Post('upload')
  @Permissions('run_imports')
  @UseInterceptors(FileInterceptor('file', FilesController.uploadOptions))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.uploadGeneralFile(file, user?.userId);
  }

  @Get('local')
  @Permissions('run_imports')
  async serveLocalFile(@Query('path') filePath: string, @Res() res: Response) {
    if (!filePath || typeof filePath !== 'string') {
      throw new BadRequestException('path query parameter is required');
    }

    const file = await this.filesService.getLocalFile(filePath);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': file.size,
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.originalName)}"`,
      'Cache-Control': 'no-store',
    });
    res.send(file.buffer);
  }

  @Get(':id')
  @Permissions('run_imports')
  async getFile(@Param('id') id: string) {
    const file = await this.filesService.getGeneralFileById(id);
    if (!file) {
      return { error: 'File not found' };
    }
    return {
      id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      downloadUrl: `/files/${id}/download`,
    };
  }

  @Get(':id/download')
  @Permissions('run_imports')
  async downloadFile(@Param('id') id: string, @Res() res: Response) {
    const file = await this.filesService.getGeneralFileById(id);
    if (!file) {
      throw new BadRequestException('File not found');
    }

    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': file.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalName)}"`,
      'Cache-Control': 'no-store',
    });
    res.send(file.buffer);
  }

  @Get(':id/preview')
  @Permissions('run_imports')
  async previewFile(@Param('id') id: string, @Res() res: Response) {
    const file = await this.filesService.getGeneralFileById(id);
    if (!file) {
      throw new BadRequestException('File not found');
    }

    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': file.size,
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.originalName)}"`,
      'Cache-Control': 'no-store',
    });
    res.send(file.buffer);
  }
}
