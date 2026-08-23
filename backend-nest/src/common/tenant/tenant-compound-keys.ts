/**
 * Compound unique keys that begin with tenantId, generated from the schema.
 *
 * Services address rows by their business key (employeeId, sku, deviceId...)
 * because that is what the domain uses. Those keys are only unique *within* a
 * factory now, so update/delete/upsert must be rewritten into the compound
 * form Prisma expects. The tenant extension does that at query time.
 */
export interface CompoundKey {
  key: string;
  fields: string[];
}

export const TENANT_COMPOUND_KEYS: Record<string, CompoundKey[]> = {
  employee: [
    { key: 'tenantId_employeeId', fields: ['employeeId'] },
    { key: 'tenantId_biometricNumber', fields: ['biometricNumber'] },
    { key: 'tenantId_nationalId', fields: ['nationalId'] },
  ],
  department: [
    { key: 'tenantId_name', fields: ['name'] },
  ],
  device: [
    { key: 'tenantId_deviceId', fields: ['deviceId'] },
  ],
  attendanceRecord: [
    { key: 'tenantId_employeeId_timestamp_type', fields: ['employeeId', 'timestamp', 'type'] },
  ],
  dailyAttendanceLog: [
    { key: 'tenantId_employeeId_date_recordType_source', fields: ['employeeId', 'date', 'recordType', 'source'] },
  ],
  product: [
    { key: 'tenantId_sku', fields: ['sku'] },
  ],
  stockLevel: [
    { key: 'tenantId_sku_location', fields: ['sku', 'location'] },
  ],
  warehouse: [
    { key: 'tenantId_code', fields: ['code'] },
  ],
  purchaseOrder: [
    { key: 'tenantId_poNumber', fields: ['poNumber'] },
  ],
  goodsReceipt: [
    { key: 'tenantId_receiptNumber', fields: ['receiptNumber'] },
  ],
  salesOrder: [
    { key: 'tenantId_soNumber', fields: ['soNumber'] },
  ],
  account: [
    { key: 'tenantId_code', fields: ['code'] },
  ],
  journalEntry: [
    { key: 'tenantId_entryNumber', fields: ['entryNumber'] },
  ],
  importJob: [
    { key: 'tenantId_jobId', fields: ['jobId'] },
  ],
  payrollRun: [
    { key: 'tenantId_runId', fields: ['runId'] },
  ],
  payrollItem: [
    { key: 'tenantId_payrollRunId_employeeId', fields: ['payrollRunId', 'employeeId'] },
  ],
  payrollReceipt: [
    { key: 'tenantId_employeeId_month', fields: ['employeeId', 'month'] },
  ],
  payrollInput: [
    { key: 'tenantId_employeeId_periodStart_periodEnd', fields: ['employeeId', 'periodStart', 'periodEnd'] },
  ],
  employeeSalary: [
    { key: 'tenantId_employeeId', fields: ['employeeId'] },
  ],
  employeeInsurance: [
    { key: 'tenantId_employeeId', fields: ['employeeId'] },
  ],
  bus: [
    { key: 'tenantId_busId', fields: ['busId'] },
    { key: 'tenantId_plateNumber', fields: ['plateNumber'] },
  ],
  busPassenger: [
    { key: 'tenantId_busId_employeeId', fields: ['busId', 'employeeId'] },
  ],
  notification: [
    { key: 'tenantId_dedupeKey', fields: ['dedupeKey'] },
  ],
};
