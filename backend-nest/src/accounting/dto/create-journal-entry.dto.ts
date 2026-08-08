import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class JournalEntryLineDto {
  @IsUUID()
  @IsNotEmpty()
  accountId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  debit: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  credit: number;
}

export class CreateJournalEntryDto {
  @IsOptional()
  @IsDateString()
  entryDate?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => JournalEntryLineDto)
  lines: JournalEntryLineDto[];
}
