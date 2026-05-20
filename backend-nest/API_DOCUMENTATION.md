# API Documentation (Backend)

This document provides a complete guide for the Frontend team to interact with the Warehouse Management System API.

**Base URL:** `/api`

---

## 🔐 Authentication

All endpoints (except login/register) require a **JWT Token** in the `Authorization` header.

**Header:**
`Authorization: Bearer <your_token>`

### 1. Login
- **Endpoint:** `POST /auth/login`
- **Body:** `{ "username": "...", "password": "..." }`
- **Response:** `{ "token": "...", "user": { ... } }`

### 2. Register (New User)
- **Endpoint:** `POST /auth/register`
- **Body:** `{ "username": "...", "email": "...", "password": "..." }`

---

## 👥 Employees Management

### 1. List Employees
Retrieve a paginated list of employees.

- **Endpoint:** `GET /employees`
- **Auth Required:** Yes (`view_employees` permission)
- **Query Parameters:**
  | Parameter | Type | Description |
  |---|---|---|
  | `page` | number | Page number (default: 1) |
  | `limit` | number | Items per page (default: 20) |
  | `department` | string | Filter by department name |
  | `status` | string | Filter by status (`active`, `inactive`, `terminated`) |
  | `search` | string | Search by name, ID, username, mobile, or national ID |

- **Response (Success 200):**
```json
{
  "employees": [
    {
      "id": "uuid",
      "employeeId": "EMP001",
      "name": "John Doe",
      "username": "johndoe",
      "mobile": "123456789",
      "nationalId": "1234567890",
      "dateOfBirth": "1990-01-01",
      "gender": "male",
      "jobTitle": "Manager",
      "profession": "Manager",
      "hourlyRate": "10.50",
      "baseSalary": "500.00",
      "lumpSumSalary": "0.00",
      "livingAllowance": "50.00",
      "roleId": "uuid",
      "department": "Warehouse",
      "departmentId": "uuid",
      "scheduledStart": "08:00",
      "scheduledEnd": "16:00",
      "employmentStartDate": "2023-01-01",
      "status": "active",
      "workDaysInPeriod": 26,
      "hoursPerDay": 8,
      "gracePeriodMinutes": 15
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 100, "pages": 5 }
}
```

### 2. Create Employee
**Note:** This automatically creates a corresponding `User` account for login.

- **Endpoint:** `POST /employees`
- **Auth Required:** Yes (`edit_employees` permission)
- **Request Body:**
| Field | Type | Required | Description |
|---|---|---|---|
| `employeeId` | string | Yes | Format: `EMP` + 3+ digits (e.g. `EMP001`) |
| `name` | string | Yes | Full name |
| `username` | string | Yes | Login username |
| `password` | string | Yes | Login password |
| `mobile` | string | No | Phone number |
| `nationalId` | string | No | National ID |
| `dateOfBirth` | string | No | ISO Date (YYYY-MM-DD) |
| `gender` | string | No | `male` or `female` |
| `jobTitle` | string | No | Job title |
| `profession` | string | No | Profession |
| `department` | string | No | Department name |
| `baseSalary` | number | No | Monthly base salary |
| `lumpSumSalary` | number | No | Lump sum salary |
| `livingAllowance` | number | No | Living allowance |
| `roleId` | string | Yes | Valid Role UUID |
| `scheduledStart`| string | No | Format `HH:mm` |
| `scheduledEnd` | string | No | Format `HH:mm` |
| `employmentStartDate`| string | No | ISO Date |
| `workDaysInPeriod`| number | No | Default: 26 |
| `hoursPerDay` | number | No | Default: 8 |
| `gracePeriodMinutes`| number | No | Default: 15 |

- **Response (Success 201):**
```json
{ "message": "Employee created successfully", "employee": { ... } }
```

### 3. Update Employee
- **Endpoint:** `PUT /employees/:employeeId`
- **Auth Required:** Yes (`edit_employees` permission)
- **Request Body:** Same as `CreateEmployeeDto` but all fields are optional.

### 4. Get Employee Profile
- **Endpoint:** `GET /employees/:employeeId/profile`
- **Auth Required:** Yes (`view_employees` permission)
- **Query Parameters:** `startDate`, `endDate`, `attendanceLimit`, `advancesLimit`, `bonusesLimit` (all optional).

### 5. Terminate / Settle / Remove
- **Terminate:** `PATCH /employees/:employeeId/terminate` (Body: `{ "terminationDate": "...", "terminationReason": "..." }`)
- **Settle:** `PATCH /employees/:employeeId/settle`
- **Remove:** `DELETE /employees/:employeeId`

---

## 🚌 Transportation Management

### 1. List Buses
- **Endpoint:** `GET /transportation/buses`
- **Auth Required:** Yes (`view_employees` permission)

### 2. Create Bus
- **Endpoint:** `POST /transportation/buses`
- **Auth Required:** Yes (`edit_employees` permission)

### 3. Add Passenger to Bus
- **Endpoint:** `POST /transportation/buses/:busId/passengers`
- **Auth Required:** Yes (`edit_employees` permission)

---

## 💰 Payroll & Attendance

### 1. Attendance (Biometric)
- **Start Login:** `POST /auth/biometric/login/start`
- **Finish Login:** `POST /auth/biometric/login/finish` (Includes `markAttendance: true`)

### 2. Calculate Deductions
- **Endpoint:** `POST /transportation/calculate-deductions`
- **Auth Required:** Yes (`view_payroll` permission)
```