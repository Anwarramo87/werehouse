import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AddPassengerDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsOptional()
  @IsDateString()
  joinDate?: string;
}
