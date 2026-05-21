// Standalone reproduction of the exact NestJS validation that runs on POST /employees
require('dotenv').config();

const { validate, ValidationError } = require('class-validator');
const { plainToInstance } = require('class-transformer');

// We must import the real DTO from the project
const { CreateEmployeeDto } = require('./src/employees/dto/create-employee.dto');

async function runValidation(payload) {
  console.log('=== Payload being validated ===');
  console.dir(payload, { depth: 2 });

  const dtoInstance = plainToInstance(CreateEmployeeDto, payload);

  const errors = await validate(dtoInstance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    console.log('\n❌ VALIDATION FAILED (this is what causes the 400 Bad Request)');
    const messages = flattenValidationErrors(errors);
    console.log('Validation error messages:');
    messages.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    return false;
  } else {
    console.log('\n✅ DTO validation passed (no class-validator errors)');
    return true;
  }
}

function flattenValidationErrors(errors, parentPath = '') {
  const result = [];
  for (const err of errors) {
    const propertyPath = parentPath ? `${parentPath}.${err.property}` : err.property;

    if (err.constraints) {
      for (const [key, msg] of Object.entries(err.constraints)) {
        result.push(`${propertyPath}: ${msg}`);
      }
    }

    if (err.children && err.children.length > 0) {
      result.push(...flattenValidationErrors(err.children, propertyPath));
    }
  }
  return result;
}

// === COMMON TEST CASES ===

const minimalGood = {
  employeeId: 'EMP123',
  name: 'Test User',
  username: 'testuser123',
  roleId: 'some-valid-uuid-here',
  hourlyRate: 120,
};

const typicalFrontendPayload = {
  employeeId: 'EMP001',
  name: 'Ahmed Test',
  username: 'ahmed.test',
  password: '',
  mobile: '0999123456',
  nationalId: '',
  dateOfBirth: '1995-05-20',
  gender: 'male',
  jobTitle: 'عامل',
  profession: 'عامل',
  department: 'قسم التعبئة',
  hourlyRate: 150,
  baseSalary: 0,
  livingAllowance: 0,
  roleId: 'the-role-id-from-your-form',
  scheduledStart: '08:00',
  scheduledEnd: '16:00',
  employmentStartDate: '2026-05-01',
  workDaysInPeriod: 26,
  hoursPerDay: 8,
  gracePeriodMinutes: 15,
};

async function main() {
  console.log('--- Test 1: Minimal payload (what the DTO strictly requires) ---');
  await runValidation(minimalGood);

  console.log('\n\n--- Test 2: Typical payload a frontend form would send ---');
  await runValidation(typicalFrontendPayload);

  // You can also test the exact payload your frontend is sending by pasting it here
  // const yourPayload = { ... };
  // await runValidation(yourPayload);
}

main().catch(console.error);
