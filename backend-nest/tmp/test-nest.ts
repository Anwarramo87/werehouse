import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { EmployeesService } from '../src/employees/employees.service';

async function bootstrap() {
  try {
    const app = await NestFactory.createApplicationContext(AppModule);
    const employeesService = app.get(EmployeesService);

    console.log('Testing getResignedEmployees...');
    const result = await employeesService.getResignedEmployees({} as any);
    console.log('Result:', result.employees?.length);
    
    await app.close();
  } catch (err: any) {
    console.error('CAUGHT_ERROR_FROM_NESTJS:');
    console.error(err);
  }
}

bootstrap();
