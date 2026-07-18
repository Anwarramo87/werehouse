import { Module } from '@nestjs/common';
import { TrashController } from './trash.controller';
import { TrashService } from './trash.service';
import { AdvancesModule } from '../advances/advances.module';
import { PenaltiesModule } from '../penalties/penalties.module';
import { BonusesModule } from '../bonuses/bonuses.module';
import { LeavesModule } from '../leaves/leaves.module';
import { EmployeesModule } from '../employees/employees.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { SalaryModule } from '../salary/salary.module';

@Module({
  imports: [
    AdvancesModule,
    PenaltiesModule,
    BonusesModule,
    LeavesModule,
    EmployeesModule,
    AttendanceModule,
    SalaryModule,
  ],
  controllers: [TrashController],
  providers: [TrashService],
})
export class TrashModule {}
