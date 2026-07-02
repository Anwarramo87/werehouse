/**
 * 🧪 Test Duplicate Handling Scenarios
 * 
 * Run this file to test different duplicate handling strategies
 * Usage: npx ts-node src/biometric/test-duplicate-scenarios.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface TestScenario {
  name: string;
  description: string;
  scans: Array<{ time: string; type: 'check-in' | 'check-out' }>;
  expectedResult: {
    keep_first: string;
    keep_last: string;
    keep_earliest: string;
    average: string;
  };
}

const scenarios: TestScenario[] = [
  {
    name: '🎯 Scenario 1: Accidental Double Scan',
    description: 'Employee scans twice by accident within 15 seconds',
    scans: [
      { time: '08:00:00', type: 'check-in' },
      { time: '08:00:15', type: 'check-in' },
    ],
    expectedResult: {
      keep_first: '08:00:00',
      keep_last: '08:00:15',
      keep_earliest: '08:00:00',
      average: '08:00:07',
    },
  },
  {
    name: '🎯 Scenario 2: Late Arrival with Early Correction',
    description: 'Employee arrives at 8:05, then tries to scan earlier at 8:00',
    scans: [
      { time: '08:05:00', type: 'check-in' },
      { time: '08:00:00', type: 'check-in' },
    ],
    expectedResult: {
      keep_first: '08:05:00',
      keep_last: '08:00:00',
      keep_earliest: '08:00:00',
      average: '08:02:30',
    },
  },
  {
    name: '🎯 Scenario 3: Check-Out Overtime',
    description: 'Employee scans out at 5:00, then again at 5:10 (more work)',
    scans: [
      { time: '17:00:00', type: 'check-out' },
      { time: '17:10:00', type: 'check-out' },
    ],
    expectedResult: {
      keep_first: '17:00:00',
      keep_last: '17:10:00',
      keep_earliest: '17:10:00', // For check-out, keep_earliest = keep latest
      average: '17:05:00',
    },
  },
  {
    name: '🎯 Scenario 4: Multiple Attempts (Wrong Finger)',
    description: 'Employee tries 3 times with different fingers',
    scans: [
      { time: '08:00:00', type: 'check-in' },
      { time: '08:00:30', type: 'check-in' },
      { time: '08:01:00', type: 'check-in' },
    ],
    expectedResult: {
      keep_first: '08:00:00',
      keep_last: '08:01:00',
      keep_earliest: '08:00:00',
      average: '08:00:30',
    },
  },
  {
    name: '🎯 Scenario 5: Beyond Window (New Record)',
    description: 'Scans 10 minutes apart - should be separate records',
    scans: [
      { time: '08:00:00', type: 'check-in' },
      { time: '08:10:00', type: 'check-in' },
    ],
    expectedResult: {
      keep_first: '08:00:00 & 08:10:00 (2 records)',
      keep_last: '08:00:00 & 08:10:00 (2 records)',
      keep_earliest: '08:00:00 & 08:10:00 (2 records)',
      average: '08:00:00 & 08:10:00 (2 records)',
    },
  },
];

function printScenarios() {
  console.log('\n'.padEnd(80, '='));
  console.log('🧪 BIOMETRIC DUPLICATE HANDLING TEST SCENARIOS');
  console.log(''.padEnd(80, '=') + '\n');

  scenarios.forEach((scenario, index) => {
    console.log(`\n${scenario.name}`);
    console.log(`📝 ${scenario.description}\n`);

    console.log('📥 Scans:');
    scenario.scans.forEach((scan, i) => {
      const icon = scan.type === 'check-in' ? '➡️' : '⬅️';
      console.log(`   ${icon} Scan ${i + 1}: ${scan.time} (${scan.type})`);
    });

    console.log('\n🎯 Expected Results by Strategy:');
    console.log(`   keep_first:    ${scenario.expectedResult.keep_first}`);
    console.log(`   keep_last:     ${scenario.expectedResult.keep_last}`);
    console.log(`   keep_earliest: ${scenario.expectedResult.keep_earliest} ⭐`);
    console.log(`   average:       ${scenario.expectedResult.average}`);
    console.log('\n' + '-'.repeat(80));
  });

  console.log('\n💡 Recommendations:');
  console.log('   ⭐ keep_earliest: Most fair for employees');
  console.log('   🔒 keep_first: Strictest, prevents manipulation');
  console.log('   🔄 keep_last: Most flexible, allows corrections');
  console.log('   📊 average: Most accurate statistically\n');

  console.log('⚙️  Current Configuration:');
  console.log(`   Strategy: ${process.env.BIOMETRIC_DUPLICATE_STRATEGY || 'keep_earliest'}`);
  console.log(`   Window: ${process.env.BIOMETRIC_DUPLICATE_WINDOW_MINUTES || '5'} minutes\n`);

  console.log(''.padEnd(80, '=') + '\n');
}

async function runLiveTest() {
  console.log('🧪 Running live test with database...\n');

  const testEmployeeId = 'EMP900999'; // Test employee
  const today = new Date().toISOString().split('T')[0];

  try {
    // Create test employee if doesn't exist
    await prisma.employee.upsert({
      where: { employeeId: testEmployeeId },
      update: {},
      create: {
        employeeId: testEmployeeId,
        name: 'Test Employee - Duplicates',
        department: 'Testing',
        hourlyRate: 1000,
        currency: 'SYP',
        status: 'active',
        workDaysInPeriod: 26,
        hoursPerDay: 8,
        gracePeriodMinutes: 5,
      },
    });

    console.log(`✅ Test employee ${testEmployeeId} ready\n`);

    // Clean up previous test data
    await prisma.attendanceRecord.deleteMany({
      where: { employeeId: testEmployeeId, date: today },
    });

    console.log('🧹 Cleaned up previous test data\n');

    console.log('📝 To test, run sync with these scenarios in simulator\n');
    console.log('Then check database:');
    console.log(`   SELECT * FROM attendance_records WHERE employeeId = '${testEmployeeId}' AND date = '${today}' ORDER BY timestamp;\n`);
  } catch (error) {
    const err = error as Error;
    console.error('❌ Error:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--live')) {
    void runLiveTest();
  } else {
    printScenarios();
    console.log('\n💡 Tip: Run with --live flag to test with real database');
    console.log('   npx ts-node src/biometric/test-duplicate-scenarios.ts --live\n');
  }
}

export { scenarios };
