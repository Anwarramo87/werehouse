import { IsOptional, IsString } from 'class-validator';

export class ListNotificationsQueryDto {
  @IsOptional()
  @IsString()
  unreadOnly?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export class MarkReadDto {
  @IsOptional()
  @IsString()
  id?: string;
}

export class DismissNotificationDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  dedupeKey?: string;
}
