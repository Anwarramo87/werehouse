# 05 — Frontend Audit

## Quality metrics (measured)
| Metric | Count |
|---|---|
| TS/TSX files | 166 |
| LOC | ~40,700 |
| Pages (App Router) | 22 |
| Components | 59 |
| Hooks (incl. React Query) | 32 |
| Stores | 2 |
| Layouts | 3 |
| Production build | success (26 static pages generated) |
| ESLint errors | 0 (13 warnings: cognitive-complexity) |
| Typecheck | clean |

## Rendering strategy
- App Router with Server + Client Components. Several heavy client components
  (`ManageSalaryModal`, `LeaveRequestModal`, `FinancialSettlementModal`) carry
  high cyclomatic complexity (26–34 vs 25 allowed). These are warning-level,
  not errors.
- `next build` used Turbopack; one non-blocking warning: custom Cache-Control on
  `/_next/static/`.

## Module-by-module (by domain)
### Attendance UI
- Strengths: hydration-safe mount flag; invalidation fixed (`exact:false` +
  deductions/payroll). Realtime invalidation wired.
- Weaknesses: `useAttendance.ts` single hook is large (high complexity, 35).
- Perf: large monthly fetches paginated client-side (safeLimit 500).

### Payroll / Salaries UI
- Strengths: dedicated client components; query hooks centralized.
- Weaknesses: `ManageSalaryModal` ref-in-render lint fixed via `useCallback`.

### Shared
- `query-keys.ts` single source of truth (roots fixed for salaries/buses).
- `RealtimeInvalidator` maps socket events → cache invalidation.

## Known issues
- 13 cognitive-complexity warnings (refactor candidates, non-blocking).
- `setMounted(true)` in effect (attendance page) — canonical pattern, justified.

## Future improvements
- Split high-complexity modal components.
- Add component-level error boundaries beyond global.
- Bundle analysis: total static chunks ~3.47 MB (measure route-level split before optimizing).
