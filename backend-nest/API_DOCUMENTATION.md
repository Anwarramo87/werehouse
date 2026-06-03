# API Documentation - HR Attendance and Salary Testing Environment

This document outlines the core API endpoints for the HR Attendance and Salary testing environment. The base URL for all API calls is assumed to be `http://<your-backend-ip>:3000/api/v1`.

---

## 1. Employee Management

### **POST /employees**

Adds a new test employee to the system.

*   **URL**: `/employees`
*   **Method**: `POST`
*   **Authentication**: Required (JWT stored in HttpOnly cookie `warehouse_access_token`)
*   **Permissions**: `edit_employees`
*   **Request Body (JSON)**:

    ```json
    {
      "name": "John Doe",
      "employeeId": "EMP001",
      "mobile": "+1234567890",
      "residence": "Some City, Some Country",
      "nationalId": "123456789012",
      "dateOfBirth": "1990-01-15",
      "gender": "Male",
      "jobTitle": "Software Engineer",
      "profession": "Engineering",
      "hourlyRate": 25.50,
      "dailyRate": 204.00,
      "baseSalary": 4080.00,
      "livingAllowance": 500.00,
      "employmentStartDate": "2023-01-01",
      "department": "IT",
      "status": "active"
    }
    ```

    *   `name` (string, required): Employee's full name.
    *   `employeeId` (string, required): Unique identifier for the employee.
    *   `mobile` (string, optional): Employee's mobile number.
    *   `residence` (string, optional): Employee's residential address.
    *   `nationalId` (string, optional): Employee's national identification number (must be unique).
    *   `dateOfBirth` (string, optional, `YYYY-MM-DD` format): Employee's date of birth.
    *   `gender` (string, optional): Employee's gender.
    *   `jobTitle` (string, optional): Employee's job title.
    *   `profession` (string, optional): Employee's profession.
    *   `hourlyRate` (number, required): Hourly rate for the employee.
    *   `dailyRate` (number, optional): Daily rate for the employee.
    *   `baseSalary` (number, optional): Base monthly salary.
    *   `livingAllowance` (number, optional): Living allowance.
    *   `employmentStartDate` (string, optional, `YYYY-MM-DD` format): Date when employment started.
    *   `department` (string, optional): Employee's department.
    *   `status` (string, optional, default: `active`): Employee's employment status.

*   **Expected Response (201 Created)**:

    ```json
    {
      "id": "uuid-of-new-employee",
      "employeeId": "EMP001",
      "name": "John Doe",
      "mobile": "+1234567890",
      "residence": "Some City, Some Country",
      "nationalId": "123456789012",
      "dateOfBirth": "1990-01-15T00:00:00.000Z",
      "gender": "Male",
      "jobTitle": "Software Engineer",
      "profession": "Engineering",
      "hourlyRate": "25.50",
      "dailyRate": "204.00",
      "baseSalary": "4080.00",
      "livingAllowance": "500.00",
      "currency": "SYP",
      "employmentStartDate": "2023-01-01T00:00:00.000Z",
      "terminationDate": null,
      "terminationReason": null,
      "terminationType": null,
      "terminationNotes": null,
      "isSettled": false,
      "financialSettlementStatus": "pending",
      "financialSettlementDate": null,
      "rehireDate": null,
      "isFinanciallySettled": false,
      "department": "IT",
      "departmentId": "uuid-of-department",
      "status": "active",
      "workDaysInPeriod": 26,
      "hoursPerDay": 8,
      "gracePeriodMinutes": 15,
      "createdAt": "2024-06-01T12:00:00.000Z",
      "updatedAt": "2024-06-01T12:00:00.000Z"
    }
    ```

### **GET /employees**

Retrieves a list of all employees, with optional filtering and pagination.

*   **URL**: `/employees`
*   **Method**: `GET`
*   **Authentication**: Required
*   **Permissions**: `view_employees`
*   **Query Parameters**:

    *   `page` (number, optional, default: 1): The page number for pagination.
    *   `limit` (number, optional, default: 10): The number of employees per page.
    *   `search` (string, optional): A search term to filter employees by name or employeeId.
    *   `status` (string, optional): Filter by employee status (e.g., `active`, `terminated`).
    *   `department` (string, optional): Filter by department name.

*   **Expected Response (200 OK)**:

    ```json
    {
      "data": [
        {
          "id": "uuid-of-employee-1",
          "employeeId": "EMP001",
          "name": "John Doe",
          "hourlyRate": "25.50",
          "dailyRate": "204.00",
          "department": "IT",
          "status": "active"
          // ... other employee fields
        },
        {
          "id": "uuid-of-employee-2",
          "employeeId": "EMP002",
          "name": "Jane Smith",
          "hourlyRate": "30.00",
          "dailyRate": "240.00",
          "department": "HR",
          "status": "active"
          // ... other employee fields
        }
      ],
      "meta": {
        "total": 2,
        "lastPage": 1,
        "currentPage": 1,
        "perPage": 10
      }
    }
    ```

---

## 2. Attendance Management

### **POST /attendance/check-in**

Records an employee's check-in. This endpoint does not require authentication for biometric device integration.

*   **URL**: `/attendance/check-in`
*   **Method**: `POST`
*   **Authentication**: Not Required (Public access for biometric devices)
*   **Request Body (JSON)**:

    ```json
    {
      "employeeId": "EMP001"
    }
    ```

    *   `employeeId` (string, required): The unique identifier of the employee checking in.

*   **Expected Response (201 Created)**:

    ```json
    {
      "message": "Check-in successful",
      "employeeId": "EMP001",
      "timestamp": "2024-06-01T08:00:00.000Z"
    }
    ```

*   **Error Responses**:
    *   **400 Bad Request**: `{"statusCode": 400, "message": "employeeId is required"}` if `employeeId` is missing.
    *   **400 Bad Request**: `{"statusCode": 400, "message": "Employee already checked in today"}` if the employee has already checked in for the current day.

### **POST /attendance/check-out**

Records an employee's check-out and calculates the hours worked for the shift. This endpoint does not require authentication for biometric device integration.

*   **URL**: `/attendance/check-out`
*   **Method**: `POST`
*   **Authentication**: Not Required (Public access for biometric devices)
*   **Request Body (JSON)**:

    ```json
    {
      "employeeId": "EMP001"
    }
    ```

    *   `employeeId` (string, required): The unique identifier of the employee checking out.

*   **Expected Response (201 Created)**:

    ```json
    {
      "message": "Check-out successful",
      "employeeId": "EMP001",
      "timestamp": "2024-06-01T17:00:00.000Z",
      "hoursWorked": 9.00
    }
    ```

*   **Error Responses**:
    *   **400 Bad Request**: `{"statusCode": 400, "message": "employeeId is required"}` if `employeeId` is missing.
    *   **400 Bad Request**: `{"statusCode": 400, "message": "Employee already checked out today"}` if the employee has already checked out for the current day.
    *   **400 Bad Request**: `{"statusCode": 400, "message": "Employee must check in first"}` if there is no corresponding check-in record for the current day.

---

## 3. Salary Calculation

### **GET /salary/calculate**

Calculates the gross and net salary for a specific employee for a given month and year, based on recorded attendance. This endpoint does not require authentication for biometric device integration.

*   **URL**: `/salary/public/calculate`
*   **Method**: `GET`
*   **Authentication**: Not Required (Public access for biometric devices)
*   **Query Parameters**:

    *   `employeeId` (string, required): The unique identifier of the employee.
    *   `month` (string, required): The month for salary calculation (e.g., `01` for January, `12` for December).
    *   `year` (number, required): The year for salary calculation (e.g., `2024`).

*   **Expected Response (200 OK)**:

    ```json
    {
      "employeeId": "EMP001",
      "employeeName": "John Doe",
      "period": {
        "startDate": "2024-01-01",
        "endDate": "2024-01-31"
      },
      "hoursWorked": 160.00,
      "hourlyRate": 25.50,
      "grossSalary": 4080.00,
      "deductions": 0,
      "netSalary": 4080.00
    }
    ```

*   **Error Responses**:
    *   **400 Bad Request**: `{"statusCode": 400, "message": "employeeId, month, and year are required"}` if any required query parameter is missing.
    *   **400 Bad Request**: `{"statusCode": 400, "message": "Employee not found"}` if the provided `employeeId` does not exist.
