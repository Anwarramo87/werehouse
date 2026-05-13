import { IsDateString, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { LeaveRequestStatusDto, LeaveRequestTypeDto } from './create-leave-request.dto';

export class LeavesListQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/)
  employeeId?: string;

  @IsOptional()
  @IsEnum(LeaveRequestTypeDto)
  leaveType?: LeaveRequestTypeDto;

  @IsOptional()
  @IsEnum(LeaveRequestStatusDto)
  status?: LeaveRequestStatusDto;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}
