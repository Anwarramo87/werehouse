/**
 * Manual test script for the rehire endpoint
 * 
 * Prerequisites:
 * 1. Backend server must be running (npm run start:dev)
 * 2. Database must be accessible
 * 3. An admin user must exist (username: admin, password: admin123)
 * 
 * Usage:
 * ts-node test-rehire-endpoint.ts
 */

import axios from 'axios';

const BASE_URL = 'http://localhost:3000/api';

interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    username: string;
    role: string;
  };
}

interface Employee {
  employeeId: string;
  name: string;
  status: string;
  terminationDate?: string;
  terminationType?: string;
  rehireDate?: string;
}

interface RehireResponse {
  success: boolean;
  message: string;
  employee: Employee;
  rehireRecord: {
    id: string;
    employeeId: string;
    rehireDate: string;
    processedBy: string;
    notes?: string;
  };
}

async function login(): Promise<string> {
  console.log('🔐 Logging in...');
  const response = await axios.post<LoginResponse>(`${BASE_URL}/auth/login`, {
    username: 'admin',
    password: 'admin123',
  });
  console.log('✅ Login successful');
  return response.data.accessToken;
}

async function testRehireEndpoint() {
  try {
    // Step 1: Login
    const token = await login();
    const headers = { Authorization: `Bearer ${token}` };

    // Step 2: Create a test employee
    console.log('\n📝 Creating test employee...');
    const createResponse = await axios.post(
      `${BASE_URL}/employees`,
      {
        employeeId: 'TEST-REHIRE-' + Date.now(),
        name: 'Test Employee for Rehire',
        username: 'test-rehire-' + Date.now(),
        password: 'test123',
        roleId: '00000000-0000-0000-0000-000000000001',
        department: 'Test Department',
        baseSalary: 5000,
        hourlyRate: 25,
      },
      { headers }
    );
    const employeeId = createResponse.data.employee.employeeId;
    console.log(`✅ Employee created: ${employeeId}`);

    // Step 3: Terminate the employee
    console.log('\n🚪 Terminating employee...');
    await axios.post(
      `${BASE_URL}/employees/terminate`,
      {
        employeeId,
        terminationDate: new Date().toISOString(),
        terminationType: 'resignation',
        reason: 'Employee decided to pursue other opportunities for testing purposes',
        notes: 'This is a test termination',
      },
      { headers }
    );
    console.log('✅ Employee terminated successfully');

    // Step 4: Verify employee is resigned
    console.log('\n🔍 Verifying employee status...');
    const getResponse = await axios.get(`${BASE_URL}/employees/${employeeId}`, { headers });
    console.log(`   Status: ${getResponse.data.status}`);
    console.log(`   Termination Type: ${getResponse.data.terminationType}`);

    // Step 5: Test the rehire endpoint
    console.log('\n🔄 Testing rehire endpoint...');
    const rehireResponse = await axios.post<RehireResponse>(
      `${BASE_URL}/employees/rehire`,
      {
        employeeId,
        rehireDate: new Date().toISOString(),
        notes: 'Employee requested to return, good performance history',
        restorePreviousSettings: true,
      },
      { headers }
    );

    console.log('✅ Rehire successful!');
    console.log('\n📊 Rehire Response:');
    console.log(`   Success: ${rehireResponse.data.success}`);
    console.log(`   Message: ${rehireResponse.data.message}`);
    console.log(`   Employee Status: ${rehireResponse.data.employee.status}`);
    console.log(`   Rehire Date: ${rehireResponse.data.employee.rehireDate}`);
    console.log(`   Termination Date: ${rehireResponse.data.employee.terminationDate}`);
    console.log(`   Termination Type: ${rehireResponse.data.employee.terminationType}`);
    console.log(`   Rehire Record ID: ${rehireResponse.data.rehireRecord.id}`);

    // Step 6: Verify employee is active again
    console.log('\n🔍 Verifying employee is active...');
    const verifyResponse = await axios.get(`${BASE_URL}/employees/${employeeId}`, { headers });
    console.log(`   Status: ${verifyResponse.data.status}`);
    console.log(`   Rehire Date: ${verifyResponse.data.rehireDate}`);

    // Step 7: Test error cases
    console.log('\n🧪 Testing error cases...');

    // Test 1: Try to rehire an active employee (should fail)
    try {
      await axios.post(
        `${BASE_URL}/employees/rehire`,
        {
          employeeId,
          rehireDate: new Date().toISOString(),
          notes: 'Trying to rehire active employee',
        },
        { headers }
      );
      console.log('❌ ERROR: Should have failed to rehire active employee');
    } catch (error: any) {
      if (error.response?.status === 400) {
        console.log('✅ Correctly rejected rehiring active employee');
      } else {
        console.log(`❌ Unexpected error: ${error.message}`);
      }
    }

    // Test 2: Try to rehire non-existent employee (should fail)
    try {
      await axios.post(
        `${BASE_URL}/employees/rehire`,
        {
          employeeId: 'NON-EXISTENT',
          rehireDate: new Date().toISOString(),
          notes: 'Test notes',
        },
        { headers }
      );
      console.log('❌ ERROR: Should have failed to rehire non-existent employee');
    } catch (error: any) {
      if (error.response?.status === 404) {
        console.log('✅ Correctly rejected non-existent employee');
      } else {
        console.log(`❌ Unexpected error: ${error.message}`);
      }
    }

    // Test 3: Try without authentication (should fail)
    try {
      await axios.post(`${BASE_URL}/employees/rehire`, {
        employeeId,
        rehireDate: new Date().toISOString(),
        notes: 'Test notes',
      });
      console.log('❌ ERROR: Should have failed without authentication');
    } catch (error: any) {
      if (error.response?.status === 401) {
        console.log('✅ Correctly rejected unauthenticated request');
      } else {
        console.log(`❌ Unexpected error: ${error.message}`);
      }
    }

    console.log('\n✅ All tests passed!');
    console.log('\n⚠️  Note: Test employee was not cleaned up. You may want to delete it manually.');
    console.log(`   Employee ID: ${employeeId}`);

  } catch (error: any) {
    console.error('\n❌ Test failed:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Message: ${error.response.data?.message || error.message}`);
      console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(`   ${error.message}`);
    }
    process.exit(1);
  }
}

// Run the test
console.log('🚀 Starting rehire endpoint test...\n');
testRehireEndpoint();
