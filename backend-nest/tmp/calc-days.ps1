$sd = [DateTime]::Parse("2026-06-01")
$ed = [DateTime]::Parse("2026-06-30")
$count = 0
$cur = $sd
while ($cur -le $ed) {
    $day = [int]$cur.DayOfWeek
    if ($day -ne 5 -and $day -ne 6) { $count++ }
    $cur = $cur.AddDays(1)
}
Write-Host "June 2026 full month working days: $count"

$sd2 = [DateTime]::Parse("2026-06-01")
$ed2 = [DateTime]::Parse("2026-06-14")
$count2 = 0
$cur2 = $sd2
while ($cur2 -le $ed2) {
    $day2 = [int]$cur2.DayOfWeek
    if ($day2 -ne 5 -and $day2 -ne 6) { $count2++ }
    $cur2 = $cur2.AddDays(1)
}
Write-Host "June 1-14 working days: $count2"

$sd3 = [DateTime]::Parse("2026-05-01")
$ed3 = [DateTime]::Parse("2026-05-31")
$count3 = 0
$cur3 = $sd3
while ($cur3 -le $ed3) {
    $day3 = [int]$cur3.DayOfWeek
    if ($day3 -ne 5 -and $day3 -ne 6) { $count3++ }
    $cur3 = $cur3.AddDays(1)
}
Write-Host "May 2026 full month working days: $count3"
