/**
 * Test script for POST /api/employees/terminate endpoint
 * 
 * This script tests the employee termination endpoint to verify:
 * 1. Request validation using Zod schemas
 * 2. Integration with EmployeeStatusManager service
 * 3. Proper success/error responses
 * 
 * Requirements: 1.1, 1.3, 9.1
 */

import axios from 'axios';

const BASE_URL = process.env.API_URL || 'http://localhost:5001';
const API_ENDPOINT = `${BASE_URL}/api/employees/terminate`;

interface TerminateEmployeeRequest {
  employeeId: string;
  terminationDate: string;
  terminationType: 'resignation' | 'termination';
  reason: string;
  notes?: string;
}

interface TerminateEmployeeResponse {
  success: boolean;
  message: string;
  employee: any;
  terminationRecord: any;
}

async function testTerminateEndpoint() {
  console.log('🧪 Testing POST /api/employees/terminate endpoint\n');

  // Test 1: Valid termination request (resignation)
  console.log('Test 1: Valid resignation request');
  const validResignationRequest: TerminateEmployeeRequest = {
    employeeId: 'TEST001', // Replace with actual employee ID
    terminationDate: new Date().toISOString(),
    terminationType: 'resignation',
    reason: 'Employee resigned for personal reasons and career growth opportunities',
    notes: 'Good employee, eligible for rehire',
  };

  try {
    const response = await axios.post<TerminateEmployeeResponse>(
      API_ENDPOINT,
      validResignationRequest,
      {
        headers: {
          'Content-Type': 'application/json',
          // Add authentication token here
          // 'Authorization': 'Bearer YOUR_TOKEN'
        },
      }
    );

    console.log('✅ Success:', response.data.message);
    console.log('Employee Status:', response.data.employee.status);
    console.log('Termination Type:', response.data.employee.terminationType);
    console.log('Financial Settlement Status:', response.data.employee.financialSettlementStatus);
    console.log('Termination Record ID:', response.data.terminationRecord.id);
    console.log('');
  } catch (error: any) {
    if (error.response) {
      console.log('❌ Error:', error.response.data.message || error.response.data);
    } else {
      console.log('❌ Error:', error.message);
    }
    console.log('');
  }

  // Test 2: Valid termination request (termination)
  console.log('Test 2: Valid termination request');
  const validTerminationRequest: TerminateEmployeeRequest = {
    employeeId: 'TEST002', // Replace with actual employee ID
    terminationDate: new Date().toISOString(),
    terminationType: 'termination',
    reason: 'Employee terminated due to violation of company policies and repeated misconduct',
    notes: 'Not eligible for rehire',
  };

  try {
    const response = await axios.post<TerminateEmployeeResponse>(
      API_ENDPOINT,
      validTerminationRequest,
      {
        headers: {
          'Content-Type': 'application/json',
          // Add authentication token here
        },
      }
    );

    console.log('✅ Success:', response.data.message);
    console.log('Employee Status:', response.data.employee.status);
    console.log('Termination Type:', response.data.employee.terminationType);
    console.log('');
  } catch (error: any) {
    if (error.response) {
      console.log('❌ Error:', error.response.data.message || error.response.data);
    } else {
      console.log('❌ Error:', error.message);
    }
    console.log('');
  }

  // Test 3: Invalid request - missing employeeId
  console.log('Test 3: Invalid request - missing employeeId');
  const invalidRequest1 = {
    terminationDate: new Date().toISOString(),
    terminationType: 'resignation',
    reason: 'Test reason',
  };

  try {
    await axios.post(API_ENDPOINT, invalidRequest1, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('❌ Should have failed validation');
    console.log('');
  } catch (error: any) {
    if (error.response && error.response.status === 400) {
      console.log('✅ Validation error caught:', error.response.data.message);
    } else {
      console.log('❌ Unexpected error:', error.message);
    }
    console.log('');
  }

  // Test 4: Invalid request - reason too short
  console.log('Test 4: Invalid request - reason too short');
  const invalidRequest2: TerminateEmployeeRequest = {
    employeeId: 'TEST001',
    terminationDate: new Date().toISOString(),
    terminationType: 'resignation',
    reason: 'Short', // Less than 10 characters
  };

  try {
    await axios.post(API_ENDPOINT, invalidRequest2, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('❌ Should have failed validation');
    console.log('');
  } catch (error: any) {
    if (error.response && error.response.status === 400) {
      console.log('✅ Validation error caught:', error.response.data.message);
    } else {
      console.log('❌ Unexpected error:', error.message);
    }
    console.log('');
  }

  // Test 5: Invalid request - invalid termination type
  console.log('Test 5: Invalid request - invalid termination type');
  const invalidRequest3 = {
    employeeId: 'TEST001',
    terminationDate: new Date().toISOString(),
    terminationType: 'invalid_type',
    reason: 'Valid reason with more than ten characters',
  };

  try {
    await axios.post(API_ENDPOINT, invalidRequest3, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('❌ Should have failed validation');
    console.log('');
  } catch (error: any) {
    if (error.response && error.response.status === 400) {
      console.log('✅ Validation error caught:', error.response.data.message);
    } else {
      console.log('❌ Unexpected error:', error.message);
    }
    console.log('');
  }

  // Test 6: Invalid request - invalid date format
  console.log('Test 6: Invalid request - invalid date format');
  const invalidRequest4: any = {
    employeeId: 'TEST001',
    terminationDate: '2024-13-45', // Invalid date
    terminationType: 'resignation',
    reason: 'Valid reason with more than ten characters',
  };

  try {
    await axios.post(API_ENDPOINT, invalidRequest4, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('❌ Should have failed validation');
    console.log('');
  } catch (error: any) {
    if (error.response && error.response.status === 400) {
      console.log('✅ Validation error caught:', error.response.data.message);
    } else {
      console.log('❌ Unexpected error:', error.message);
    }
    console.log('');
  }

  // Test 7: Employee not found
  console.log('Test 7: Employee not found');
  const notFoundRequest: TerminateEmployeeRequest = {
    employeeId: 'NONEXISTENT999',
    terminationDate: new Date().toISOString(),
    terminationType: 'resignation',
    reason: 'Valid reason with more than ten characters',
  };

  try {
    await axios.post(API_ENDPOINT, notFoundRequest, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('❌ Should have returned 404');
    console.log('');
  } catch (error: any) {
    if (error.response && error.response.status === 404) {
      console.log('✅ Not found error caught:', error.response.data.message);
    } else {
      console.log('❌ Unexpected error:', error.message);
    }
    console.log('');
  }

  console.log('🏁 Test suite completed\n');
}

// Run tests
testTerminateEndpoint().catch(console.error);
