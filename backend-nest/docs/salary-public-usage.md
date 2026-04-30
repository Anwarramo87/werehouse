## Salary public test endpoint (development only)

This temporary endpoint is provided to help frontend/dev teams test the allowances calculation without JWT during development.

- Endpoint: `POST /api/salary/public/calculate-allowances`
- Available only when `NODE_ENV !== 'production'`.

Request body (JSON):

```json
{
  "salary": 10000000,
  "lumpSumSalary": 750000,
  "livingAllowance": 12000
}
```

Example curl:

```bash
curl -s -X POST http://localhost:5001/api/salary/public/calculate-allowances \
  -H "Content-Type: application/json" \
  -d '{"salary":10000000,"lumpSumSalary":750000,"livingAllowance":12000}' | jq
```

Notes:
- The service returns stringified numbers with 4 decimal places.
- Remove or protect this route before deploying to production.
