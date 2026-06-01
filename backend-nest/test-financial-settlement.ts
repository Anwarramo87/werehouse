/**
 * Manual test script for financial settlement endpoint
 * 
 * This script tests the POST /api/employees/financial-settlement endpoint
 * 
 * Prerequisites:
 * 1. Backend server must be running
 * 2. Database must be accessible
 * 3. An employee must be terminated/resigned before settlement
 * 
 * Usage:
 *   npx ts-node test-financial-settlement.ts
 */

import axios from 'axios';

const BASE_URL = 'http://localhost:3000/api';

interface LoginResponse {
  accessToken: string;
  user: any;
}

interface FinancialSettlementRequest {
  employeeId: string;
  settlementDate: string;
  finalSalaryAmount: number;
  deductions?: number;
  bonuses?: number;
  notes?: string;
}

async function login(): Promise<string> {
  try {
    const response = await axios.post<LoginResponse>(`${BASE_URL}/auth/login`, {
      username: 'admin',
      password: 'admin123',
    });
    console.log('✓ Login successful');
    return response.data.accessToken;
  } catch (error: any) {
    console.error('✗ Login failed:', error.response?.data || error.message);
    throw error;
  }
}

async function testFinancialSettlement(token: string, employeeId: string) {
  const settlementData: FinancialSettlementRequest = {
    employeeId,
    settlementDate: new Date().toISOString(),
    finalSalaryAmount: 5000,
    deductions: 500,
    bonuses: 1000,
    notes: 'Final settlement processed - Test',
  };

  try {
    const response = await axios.post(
      `${BASE_URL}/employees/financial-settlement`,
      settlementData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log('\n✓ Financial settlement processed successfully');
    console.log('Response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error: any) {
    console.error('\n✗ Financial settlement failed');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error:', error.message);
    }
    throw error;
  }
}

async function testInvalidCases(token: string) {
  console.log('\n--- Testing Invalid Cases ---\n');

  // Test 1: Non-existent employee
  try {
    await axios.post(
      `${BASE_URL}/employees/financial-settlement`,
      {
        employeeId: 'NON-EXISTENT',
        settlementDate: new Date().toISOString(),
        finalSalaryAmount: 5000,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    console.log('✗ Should have failed for non-existent employee');
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.log('✓ Correctly rejected non-existent employee (404)');
    } else {
      console.log('✗ Unexpected error:', error.response?.status);
    }
  }

  // Test 2: Missing required fields
  try {
    await axios.post(
      `${BASE_URL}/employees/financial-settlement`,
      {
        employeeId: 'TEST-001',
        // Missing settlementDate and finalSalaryAmount
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    console.log('✗ Should have failed for missing required fields');
  } catch (error: any) {
    if (error.response?.status === 400) {
      console.log('✓ Correctly rejected missing required fields (400)');
    } else {
      console.log('✗ Unexpected error:', error.response?.status);
    }
  }

  // Test 3: Negative amounts
  try {
    await axios.post(
      `${BASE_URL}/employees/financial-settlement`,
      {
        employeeId: 'TEST-001',
        settlementDate: new Date().toISOString(),
        finalSalaryAmount: -1000,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    console.log('✗ Should have failed for negative amount');
  } catch (error: any) {
    if (error.response?.status === 400) {
      console.log('✓ Correctly rejected negative amount (400)');
    } else {
      console.log('✗ Unexpected error:', error.response?.status);
    }
  }

  // Test 4: Without authentication
  try {
    await axios.post(
      `${BASE_URL}/employees/financial-settlement`,
      {
        employeeId: 'TEST-001',
        settlementDate: new Date().toISOString(),
        finalSalaryAmount: 5000,
      }
    );
    console.log('✗ Should have failed without authentication');
  } catch (error: any) {
    if (error.response?.status === 401) {
      console.log('✓ Correctly rejected unauthenticated request (401)');
    } else {
      console.log('✗ Unexpected error:', error.response?.status);
    }
  }
}

async function main() {
  console.log('=== Financial Settlement Endpoint Test ===\n');

  try {
    // Login
    const token = await login();

    // Get employee ID from command line or use default
    const employeeId = process.argv[2] || 'TEST-001';
    console.log(`\nTesting with employee ID: ${employeeId}`);
    console.log('Note: Employee must be resigned/terminated before settlement\n');

    // Test valid settlement
    console.log('--- Testing Valid Settlement ---\n');
    await testFinancialSettlement(token, employeeId);

    // Test invalid cases
    await testInvalidCases(token);

    console.log('\n=== All tests completed ===\n');
  } catch (error) {
    console.error('\n=== Test failed ===\n');
    process.exit(1);
  }
}

main();
