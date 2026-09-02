import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8) // أضف هذا السطر لضمان الأمان
  password: string;

  @IsString()
  @IsNotEmpty()
  roleId: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  photo?: string;

  /**
   * Factory the new user belongs to. Only the super admin may set it -- a
   * factory admin always creates users inside their own factory, and the value
   * is ignored for them (see AuthService.createUser).
   */
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}