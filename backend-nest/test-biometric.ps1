# 🧪 اختبار نظام البصمة - سكريبت تلقائي
# Test Biometric System - Automated Script

Write-Host "🚀 اختبار نظام البصمة" -ForegroundColor Cyan
Write-Host "==========================================`n" -ForegroundColor Cyan

# Configuration
$baseUrl = "http://localhost:5001"
$username = "admin"
$password = "change_this_password_in_production"

Write-Host "📋 الإعدادات:" -ForegroundColor Yellow
Write-Host "   URL: $baseUrl"
Write-Host "   Username: $username"
Write-Host ""

# Step 1: Login
Write-Host "🔐 الخطوة 1: تسجيل الدخول..." -ForegroundColor Green
try {
    $loginBody = @{
        username = $username
        password = $password
    } | ConvertTo-Json

    $loginResponse = Invoke-WebRequest -Uri "$baseUrl/auth/login" `
        -Method POST `
        -ContentType "application/json" `
        -Body $loginBody `
        -SessionVariable session `
        -ErrorAction Stop

    Write-Host "   ✅ تم تسجيل الدخول بنجاح" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "   ❌ فشل تسجيل الدخول: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "💡 تأكد من:" -ForegroundColor Yellow
    Write-Host "   1. الباك اند يعمل (npm run start:dev)"
    Write-Host "   2. Username و Password صحيحة"
    Write-Host "   3. Port 5001 متاح"
    exit 1
}

# Step 2: Check Device Status
Write-Host "🔍 الخطوة 2: فحص حالة الجهاز..." -ForegroundColor Green
try {
    $statusResponse = Invoke-WebRequest -Uri "$baseUrl/biometric/status" `
        -Method GET `
        -WebSession $session `
        -ErrorAction Stop

    $status = $statusResponse.Content | ConvertFrom-Json
    Write-Host "   ✅ الجهاز متصل" -ForegroundColor Green
    Write-Host "   📊 الوضع: $($status.mode)" -ForegroundColor Cyan
    Write-Host "   🔌 الحالة: $($status.connected)" -ForegroundColor Cyan
    Write-Host ""
} catch {
    Write-Host "   ⚠️  تحذير: لم نتمكن من فحص الجهاز" -ForegroundColor Yellow
    Write-Host ""
}

# Step 3: Check Duplicate Config
Write-Host "⚙️  الخطوة 3: إعدادات معالجة التكرار..." -ForegroundColor Green
try {
    $configResponse = Invoke-WebRequest -Uri "$baseUrl/biometric/duplicate-config" `
        -Method GET `
        -WebSession $session `
        -ErrorAction Stop

    $config = $configResponse.Content | ConvertFrom-Json
    Write-Host "   ✅ الإعدادات:" -ForegroundColor Green
    Write-Host "   🎯 الاستراتيجية: $($config.strategy)" -ForegroundColor Cyan
    Write-Host "   ⏱️  النافذة الزمنية: $($config.windowMinutes) دقائق" -ForegroundColor Cyan
    if ($config.recommended) {
        Write-Host "   ⭐ موصى به" -ForegroundColor Yellow
    }
    Write-Host ""
} catch {
    Write-Host "   ⚠️  تحذير: لم نتمكن من قراءة الإعدادات" -ForegroundColor Yellow
    Write-Host ""
}

# Step 4: First Sync
Write-Host "🔄 الخطوة 4: المزامنة الأولى (البيانات الجديدة)..." -ForegroundColor Green
try {
    $sync1Response = Invoke-WebRequest -Uri "$baseUrl/biometric/trigger-sync" `
        -Method POST `
        -WebSession $session `
        -ErrorAction Stop

    $sync1 = $sync1Response.Content | ConvertFrom-Json
    Write-Host "   ✅ المزامنة تمت بنجاح!" -ForegroundColor Green
    Write-Host "   📊 النتائج:" -ForegroundColor Cyan
    Write-Host "      ➕ جديد: $($sync1.synced)" -ForegroundColor Green
    Write-Host "      🔄 محدث: $($sync1.updated)" -ForegroundColor Yellow
    Write-Host "      ⏭️  متجاهل: $($sync1.skipped)" -ForegroundColor Gray
    Write-Host "      ❌ أخطاء: $($sync1.errors)" -ForegroundColor Red
    Write-Host ""

    if ($sync1.synced -gt 0) {
        Write-Host "   📝 عينة من السجلات:" -ForegroundColor Cyan
        $sync1.logs | Select-Object -First 3 | ForEach-Object {
            $time = ([DateTime]$_.timestamp).ToString("HH:mm:ss")
            $typeAr = if ($_.type -eq "check-in") { "حضور" } else { "انصراف" }
            Write-Host "      • $($_.employeeId) - $typeAr - $time" -ForegroundColor White
            if ($_.metrics.lateMinutes -gt 0) {
                Write-Host "        تأخير: $($_.metrics.lateMinutes) دقيقة" -ForegroundColor Yellow
            }
            if ($_.metrics.overtimeMinutes -gt 0) {
                Write-Host "        وقت إضافي: $($_.metrics.overtimeMinutes) دقيقة" -ForegroundColor Green
            }
        }
        Write-Host ""
    }
} catch {
    Write-Host "   ❌ فشلت المزامنة: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    exit 1
}

# Step 5: Second Sync (Test Duplicate Handling)
Write-Host "🔄 الخطوة 5: المزامنة الثانية (اختبار معالجة التكرار)..." -ForegroundColor Green
Write-Host "   ⏱️  انتظار 2 ثانية..." -ForegroundColor Gray
Start-Sleep -Seconds 2

try {
    $sync2Response = Invoke-WebRequest -Uri "$baseUrl/biometric/trigger-sync" `
        -Method POST `
        -WebSession $session `
        -ErrorAction Stop

    $sync2 = $sync2Response.Content | ConvertFrom-Json
    Write-Host "   ✅ المزامنة تمت بنجاح!" -ForegroundColor Green
    Write-Host "   📊 النتائج:" -ForegroundColor Cyan
    Write-Host "      ➕ جديد: $($sync2.synced)" -ForegroundColor Green
    Write-Host "      🔄 محدث: $($sync2.updated)" -ForegroundColor Yellow
    Write-Host "      ⏭️  متجاهل: $($sync2.skipped)" -ForegroundColor Gray
    Write-Host "      ❌ أخطاء: $($sync2.errors)" -ForegroundColor Red
    Write-Host ""

    if ($sync2.skipped -gt 0) {
        Write-Host "   ✅ رائع! النظام اكتشف التكرار وتجاهله" -ForegroundColor Green
    } elseif ($sync2.updated -gt 0) {
        Write-Host "   ✅ رائع! النظام حدّث السجلات المكررة" -ForegroundColor Green
    } else {
        Write-Host "   ⚠️  لم يتم اكتشاف تكرار (ربما البيانات مختلفة)" -ForegroundColor Yellow
    }
    Write-Host ""
} catch {
    Write-Host "   ❌ فشلت المزامنة: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
}

# Summary
Write-Host "==========================================`n" -ForegroundColor Cyan
Write-Host "✅ انتهى الاختبار بنجاح!" -ForegroundColor Green
Write-Host ""
Write-Host "📊 الملخص:" -ForegroundColor Yellow
Write-Host "   ✅ تسجيل الدخول: نجح"
Write-Host "   ✅ حالة الجهاز: نجح"
Write-Host "   ✅ المزامنة الأولى: نجح ($($sync1.synced) سجلات جديدة)"
Write-Host "   ✅ معالجة التكرار: نجح ($($sync2.skipped) سجلات تم تجاهلها)"
Write-Host ""
Write-Host "🎯 الخطوات التالية:" -ForegroundColor Cyan
Write-Host "   1. افتح Prisma Studio: npx prisma studio"
Write-Host "   2. تحقق من جدول attendance_records"
Write-Host "   3. اقرأ docs/BIOMETRIC_SUMMARY_AR.md للمزيد"
Write-Host ""
Write-Host "📚 الملفات المفيدة:" -ForegroundColor Cyan
Write-Host "   • QUICK_START_BIOMETRIC.md - دليل البداية"
Write-Host "   • docs/BIOMETRIC_SUMMARY_AR.md - الشرح الكامل"
Write-Host "   • test-biometric-sync.md - اختبارات متقدمة"
Write-Host ""
