/**
 * Simple test script for GET /api/employees/resigned endpoint
 * 
 * This script tests the resigned employees endpoint
 * 
 * Usage:
 *   1. Set environment variables:
 *      - API_URL (default: http://localhost:5001)
 *      - USERNAME (admin username)
 *      - PASSWORD (admin password)
 *   2. Run: npx ts-node test-resigned-endpoint-simple.ts
 */

import axios from 'axios';

const BASE_URL = process.env.API_URL || 'http://localhost:5001';
const USERNAME = process.env.USERNAME || 'admin';
const PASSWORD = process.env.PASSWORD || 'admin123';

async function login(): Promise<string> {
  console.log('🔐 Logging in...');
  try {
    const response = await axios.post(`${BASE_URL}/api/auth/login`, {
      username: USERNAME,
      password: PASSWORD,
    });
    
    console.log('✅ Login successful');
    return response.data.accessToken || response.data.access_token || response.data.token;
  } catch (error: any) {
    console.error('❌ Login failed:', error.response?.data || error.message);
    throw error;
  }
}

async function testResignedEndpoint(token: string) {
  console.log('\n🧪 Testing GET /api/employees/resigned endpoint\n');

  const testCases = [
    {
      name: 'Get all resigned employees',
      params: {},
    },
    {
      name: 'Get resigned employees from current month',
      params: { month: 'current' },
    },
    {
      name: 'Get resigned employees from previous months',
      params: { month: 'previous' },
    },
    {
      name: 'Get only resignations',
      params: { type: 'resignation' },
    },
    {
      name: 'Get only terminations',
      params: { type: 'termination' },
    },
    {
      name: 'Get employees with pending financial settlement',
      params: { financialStatus: 'pending' },
    },
    {
      name: 'Pagination test (page 1, limit 5)',
      params: { page: '1', limit: '5' },
    },
  ];

  for (const testCase of testCases) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📋 Test: ${testCase.name}`);
    console.log(`${'─'.repeat(60)}`);

    try {
      const response = await axios.get(`${BASE_URL}/api/employees/resigned`, {
        params: testCase.params,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      console.log('✅ Status:', response.status);
      console.log('📊 Response:');
      console.log('  - success:', response.data.success);
      console.log('  - employees count:', response.data.employees?.length || 0);
      
      if (response.data.pagination) {
        console.log('  - pagination:');
        console.log('    - page:', response.data.pagination.page);
        console.log('    - limit:', response.data.pagination.limit);
        console.log('    - total:', response.data.pagination.total);
        console.log('    - pages:', response.data.pagination.pages);
      }
      
      if (response.data.statistics) {
        console.log('  - statistics:');
        console.log('    - currentMonth:', response.data.statistics.currentMonth);
        console.log('    - previousMonths:', response.data.statistics.previousMonths);
        console.log('    - resignations:', response.data.statistics.resignations);
        console.log('    - terminations:', response.data.statistics.terminations);
        console.log('    - pendingSettlement:', response.data.statistics.pendingSettlement);
        if (response.data.statistics.byDepartment) {
          console.log('    - byDepartment:', JSON.stringify(response.data.statistics.byDepartment));
        }
      }

      if (response.data.employees && response.data.employees.length > 0) {
        console.log('\n📝 Sample employee (first):');
        const sample = response.data.employees[0];
        console.log('  - employeeId:', sample.employeeId);
        console.log('  - name:', sample.name);
        console.log('  - status:', sample.status);
        console.log('  - terminationType:', sample.terminationType);
        console.log('  - terminationDate:', sample.terminationDate);
        console.log('  - financialSettlementStatus:', sample.financialSettlementStatus);
        console.log('  - department:', sample.department);
      } else {
        console.log('\n📝 No employees found for this query');
      }

    } catch (error: any) {
      console.log('❌ Error:', error.response?.status || error.message);
      if (error.response?.data) {
        console.log('Error details:', JSON.stringify(error.response.data, null, 2));
      }
    }
  }
}

async function main() {
  console.log('🚀 Testing GET /api/employees/resigned endpoint');
  console.log(`📍 Base URL: ${BASE_URL}`);
  console.log(`👤 Username: ${USERNAME}`);
  console.log('');

  try {
    const token = await login();
    await testResignedEndpoint(token);
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ All tests completed successfully');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
