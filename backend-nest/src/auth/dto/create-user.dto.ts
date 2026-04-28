import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';   
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
}