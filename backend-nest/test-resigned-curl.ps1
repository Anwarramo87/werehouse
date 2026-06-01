# PowerShell script to test GET /api/employees/resigned endpoint
# Usage: .\test-resigned-curl.ps1

$BASE_URL = "http://localhost:5001"
$USERNAME = "admin"
$PASSWORD = "password123"

Write-Host "🚀 Testing GET /api/employees/resigned endpoint" -ForegroundColor Cyan
Write-Host "📍 Base URL: $BASE_URL" -ForegroundColor Gray
Write-Host ""

# Step 1: Login to get token
Write-Host "🔐 Logging in..." -ForegroundColor Yellow
$loginBody = @{
    username = $USERNAME
    password = $PASSWORD
} | ConvertTo-Json

try {
    $loginResponse = Invoke-RestMethod -Uri "$BASE_URL/api/auth/login" -Method Post -Body $loginBody -ContentType "application/json"
    $token = $loginResponse.accessToken
    if (-not $token) {
        $token = $loginResponse.access_token
    }
    if (-not $token) {
        $token = $loginResponse.token
    }
    
    if (-not $token) {
        Write-Host "❌ Failed to get token from login response" -ForegroundColor Red
        Write-Host "Response: $($loginResponse | ConvertTo-Json)" -ForegroundColor Red
        exit 1
    }
    
    Write-Host "✅ Login successful" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "❌ Login failed: $_" -ForegroundColor Red
    exit 1
}

# Step 2: Test the resigned employees endpoint
$testCases = @(
    @{ Name = "Get all resigned employees"; Params = "" },
    @{ Name = "Get resigned employees from current month"; Params = "?month=current" },
    @{ Name = "Get resigned employees from previous months"; Params = "?month=previous" },
    @{ Name = "Get only resignations"; Params = "?type=resignation" },
    @{ Name = "Get only terminations"; Params = "?type=termination" },
    @{ Name = "Get employees with pending financial settlement"; Params = "?financialStatus=pending" },
    @{ Name = "Get employees with completed financial settlement"; Params = "?financialStatus=completed" },
    @{ Name = "Pagination test (page 1, limit 5)"; Params = "?page=1&limit=5" },
    @{ Name = "Combined filters (current month + pending)"; Params = "?month=current&financialStatus=pending" }
)

foreach ($testCase in $testCases) {
    Write-Host "─" * 60 -ForegroundColor Gray
    Write-Host "📋 Test: $($testCase.Name)" -ForegroundColor Cyan
    Write-Host "─" * 60 -ForegroundColor Gray
    
    try {
        $headers = @{
            "Authorization" = "Bearer $token"
            "Content-Type" = "application/json"
        }
        
        $url = "$BASE_URL/api/employees/resigned$($testCase.Params)"
        $response = Invoke-RestMethod -Uri $url -Method Get -Headers $headers
        
        Write-Host "✅ Status: 200 OK" -ForegroundColor Green
        Write-Host "📊 Response:" -ForegroundColor White
        Write-Host "  - success: $($response.success)" -ForegroundColor Gray
        Write-Host "  - employees count: $($response.employees.Count)" -ForegroundColor Gray
        
        if ($response.pagination) {
            Write-Host "  - pagination:" -ForegroundColor Gray
            Write-Host "    - page: $($response.pagination.page)" -ForegroundColor DarkGray
            Write-Host "    - limit: $($response.pagination.limit)" -ForegroundColor DarkGray
            Write-Host "    - total: $($response.pagination.total)" -ForegroundColor DarkGray
            Write-Host "    - pages: $($response.pagination.pages)" -ForegroundColor DarkGray
        }
        
        if ($response.statistics) {
            Write-Host "  - statistics:" -ForegroundColor Gray
            Write-Host "    - currentMonth: $($response.statistics.currentMonth)" -ForegroundColor DarkGray
            Write-Host "    - previousMonths: $($response.statistics.previousMonths)" -ForegroundColor DarkGray
            Write-Host "    - resignations: $($response.statistics.resignations)" -ForegroundColor DarkGray
            Write-Host "    - terminations: $($response.statistics.terminations)" -ForegroundColor DarkGray
            Write-Host "    - pendingSettlement: $($response.statistics.pendingSettlement)" -ForegroundColor DarkGray
            
            if ($response.statistics.byDepartment) {
                Write-Host "    - byDepartment:" -ForegroundColor DarkGray
                $response.statistics.byDepartment.PSObject.Properties | ForEach-Object {
                    Write-Host "      - $($_.Name): $($_.Value)" -ForegroundColor DarkGray
                }
            }
        }
        
        if ($response.employees -and $response.employees.Count -gt 0) {
            Write-Host ""
            Write-Host "📝 Sample employee (first):" -ForegroundColor White
            $sample = $response.employees[0]
            Write-Host "  - employeeId: $($sample.employeeId)" -ForegroundColor Gray
            Write-Host "  - name: $($sample.name)" -ForegroundColor Gray
            Write-Host "  - status: $($sample.status)" -ForegroundColor Gray
            Write-Host "  - terminationType: $($sample.terminationType)" -ForegroundColor Gray
            Write-Host "  - terminationDate: $($sample.terminationDate)" -ForegroundColor Gray
            Write-Host "  - financialSettlementStatus: $($sample.financialSettlementStatus)" -ForegroundColor Gray
            Write-Host "  - department: $($sample.department)" -ForegroundColor Gray
        } else {
            Write-Host ""
            Write-Host "📝 No employees found for this query" -ForegroundColor Yellow
        }
        
    } catch {
        Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ErrorDetails) {
            Write-Host "Error details: $($_.ErrorDetails.Message)" -ForegroundColor Red
        }
    }
    
    Write-Host ""
}

Write-Host "=" * 60 -ForegroundColor Green
Write-Host "✅ All tests completed" -ForegroundColor Green
Write-Host "=" * 60 -ForegroundColor Green
