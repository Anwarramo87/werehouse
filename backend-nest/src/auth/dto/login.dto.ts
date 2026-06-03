import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    description: 'اسم المستخدم أو البريد الإلكتروني',
    example: 'admin',
  })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    description: 'كلمة المرور',
    example: 'MyPassword@123',
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}
