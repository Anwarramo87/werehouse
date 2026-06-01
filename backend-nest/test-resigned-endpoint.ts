/**
 * Test script for GET /api/employees/resigned endpoint
 * 
 * This script tests the resigned employees endpoint with various query parameters
 */

import axios from 'axios';

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const API_ENDPOINT = `${BASE_URL}/employees/resigned`;

// You'll need to replace this with a valid JWT token
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

interface TestCase {
  name: string;
  params?: Record<string, string>;
}

const testCases: TestCase[] = [
  {
    name: 'Get all resigned employees (no filters)',
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
    name: 'Get employees with completed financial settlement',
    params: { financialStatus: 'completed' },
  },
  {
    name: 'Search by name or employee ID',
    params: { search: 'test' },
  },
  {
    name: 'Filter by department',
    params: { department: 'Warehouse' },
  },
  {
    name: 'Pagination test (page 1, limit 10)',
    params: { page: '1', limit: '10' },
  },
  {
    name: 'Combined filters (current month + pending settlement)',
    params: { month: 'current', financialStatus: 'pending' },
  },
];

async function runTest(testCase: TestCase) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Test: ${testCase.name}`);
  console.log(`${'='.repeat(60)}`);

  try {
    const response = await axios.get(API_ENDPOINT, {
      params: testCase.params,
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
    });

    console.log('✅ Status:', response.status);
    console.log('📊 Response structure:');
    console.log('  - success:', response.data.success);
    console.log('  - employees count:', response.data.employees?.length || 0);
    console.log('  - pagination:', JSON.stringify(response.data.pagination, null, 2));
    console.log('  - statistics:', JSON.stringify(response.data.statistics, null, 2));

    if (response.data.employees && response.data.employees.length > 0) {
      console.log('\n📝 Sample employee data (first employee):');
      const sample = response.data.employees[0];
      console.log('  - employeeId:', sample.employeeId);
      console.log('  - name:', sample.name);
      console.log('  - status:', sample.status);
      console.log('  - terminationType:', sample.terminationType);
      console.log('  - terminationDate:', sample.terminationDate);
      console.log('  - financialSettlementStatus:', sample.financialSettlementStatus);
      console.log('  - department:', sample.department);
    }

    return { success: true, data: response.data };
  } catch (error: any) {
    console.log('❌ Error:', error.response?.status || error.message);
    if (error.response?.data) {
      console.log('Error details:', JSON.stringify(error.response.data, null, 2));
    }
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('🚀 Testing GET /api/employees/resigned endpoint');
  console.log(`📍 Base URL: ${BASE_URL}`);
  console.log(`🔑 Auth Token: ${AUTH_TOKEN ? '✓ Provided' : '✗ Missing (set AUTH_TOKEN env var)'}`);

  if (!AUTH_TOKEN) {
    console.log('\n⚠️  Warning: No auth token provided. Tests may fail with 401 Unauthorized.');
    console.log('Set AUTH_TOKEN environment variable with a valid JWT token.');
  }

  const results = [];

  for (const testCase of testCases) {
    const result = await runTest(testCase);
    results.push({ testCase: testCase.name, ...result });
    
    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 Test Summary');
  console.log('='.repeat(60));
  
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`✅ Passed: ${passed}/${results.length}`);
  console.log(`❌ Failed: ${failed}/${results.length}`);

  if (failed > 0) {
    console.log('\n❌ Failed tests:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - ${r.testCase}: ${r.error}`);
    });
  }
}

main().catch(console.error);
