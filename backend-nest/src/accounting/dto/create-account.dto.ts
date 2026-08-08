import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateAccountDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9.]+$/, { message: 'code must contain only digits and dots' })
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['asset', 'liability', 'equity', 'revenue', 'expense'])
  type: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}
