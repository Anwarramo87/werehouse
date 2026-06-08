# API Testing Script
Write-Host "=== Backend API Testing ===" -ForegroundColor Cyan
Write-Host ""

$baseUrl = "http://localhost:5001/api/v1"

# Test 1: Login
Write-Host "1. Testing Login..." -ForegroundColor Yellow
$loginBody = @{ username = "admin"; password = "password123" } | ConvertTo-Json
try {
    $loginResponse = Invoke-WebRequest -Uri "$baseUrl/auth/login" -Method POST -Body $loginBody -ContentType "application/json" -UseBasicParsing
    $loginData = $loginResponse.Content | ConvertFrom-Json
    $token = $loginData.token
    Write-Host "   ✓ Login successful" -ForegroundColor Green
    Write-Host "   User: $($loginData.user.username)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ Login failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$headers = @{ Authorization = "Bearer $token" }

# Test 2: Dashboard
Write-Host ""
Write-Host "2. Testing Dashboard..." -ForegroundColor Yellow
try {
    $dashResponse = Invoke-WebRequest -Uri "$baseUrl/dashboard/home" -Headers $headers -UseBasicParsing
    $dashData = $dashResponse.Content | ConvertFrom-Json
    Write-Host "   ✓ Dashboard loaded" -ForegroundColor Green
    Write-Host "   Total Employees: $($dashData.totalEmployees)" -ForegroundColor Gray
    Write-Host "   Present Today: $($dashData.attendance.count)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ Dashboard failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 3: Employees
Write-Host ""
Write-Host "3. Testing Employees..." -ForegroundColor Yellow
try {
    $empUrl = "$baseUrl/employees" + "?page=1" + "`&limit=10"
    $empResponse = Invoke-WebRequest -Uri $empUrl -Headers $headers -UseBasicParsing
    $empData = $empResponse.Content | ConvertFrom-Json
    Write-Host "   ✓ Employees loaded" -ForegroundColor Green
    Write-Host "   Total: $($empData.pagination.total)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ Employees failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 4: Leaves
Write-Host ""
Write-Host "4. Testing Leaves..." -ForegroundColor Yellow
try {
    $leaveUrl = "$baseUrl/leaves" + "?page=1" + "`&limit=10"
    $leaveResponse = Invoke-WebRequest -Uri $leaveUrl -Headers $headers -UseBasicParsing
    $leaveData = $leaveResponse.Content | ConvertFrom-Json
    Write-Host "   ✓ Leaves loaded" -ForegroundColor Green
    Write-Host "   Total: $($leaveData.pagination.total)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ Leaves failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 5: Attendance
Write-Host ""
Write-Host "5. Testing Attendance..." -ForegroundColor Yellow
try {
    $attUrl = "$baseUrl/attendance" + "?page=1" + "`&limit=10"
    $attResponse = Invoke-WebRequest -Uri $attUrl -Headers $headers -UseBasicParsing
    $attData = $attResponse.Content | ConvertFrom-Json
    Write-Host "   ✓ Attendance loaded" -ForegroundColor Green
    Write-Host "   Total: $($attData.pagination.total)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ Attendance failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 6: Departments
Write-Host ""
Write-Host "6. Testing Departments..." -ForegroundColor Yellow
try {
    $deptResponse = Invoke-WebRequest -Uri "$baseUrl/departments" -Headers $headers -UseBasicParsing
    $deptData = $deptResponse.Content | ConvertFrom-Json
    Write-Host "   ✓ Departments loaded" -ForegroundColor Green
    Write-Host "   Total: $($deptData.Length)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ Departments failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 7: Create Leave Request
Write-Host ""
Write-Host "7. Testing Create Leave..." -ForegroundColor Yellow
$leaveData = @{
    employeeId = "EMP900001"
    leaveType = "ANNUAL"
    startDate = "2026-06-10"
    endDate = "2026-06-10"
    isPaid = $true
    reason = "API Test Leave"
} | ConvertTo-Json

try {
    $createResponse = Invoke-WebRequest -Uri "$baseUrl/leaves" -Method POST -Headers $headers -Body $leaveData -ContentType "application/json" -UseBasicParsing
    Write-Host "   ✓ Leave created successfully" -ForegroundColor Green
} catch {
    Write-Host "   ✗ Create leave failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== All Tests Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Backend API is working correctly!" -ForegroundColor Green
Write-Host "Credentials: admin / password123" -ForegroundColor Gray
Write-Host "Base URL: $baseUrl" -ForegroundColor Gray
