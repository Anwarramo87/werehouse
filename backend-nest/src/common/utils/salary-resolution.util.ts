import { Employee, EmployeeSalary, Prisma } from '@prisma/client';

export type SalarySourceEmployee = Pick<
  Employee,
  'hourlyRate' | 'workDaysInPeriod' | 'hoursPerDay'
> & {
  baseSalary?: Employee['baseSalary'];
  livingAllowance?: Employee['livingAllowance'];
};

export type ResolvedSalary = {
  baseSalary: number;
  livingAllowance: number;
  lumpSumSalary: number;
  responsibilityAllowance: number;
  extraEffortAllowance: number;
  productionIncentive: number;
  transportAllowance: number;
  insuranceAmount: number;
  hourlyRate: number;
  workDaysInPeriod: number;
  hoursPerDay: number;
  monthlyTotal: number;
};

const toNumber = (value: Prisma.Decimal | number | string | null | undefined): number => {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value instanceof Prisma.Decimal) {
    return value.toNumber();
  }
  if (typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
};

/**
 * Single source of truth: EmployeeSalary record first, Employee fields as fallback.
 */
export type SalaryRecordLike = Partial<
  Pick<
    EmployeeSalary,
    | 'baseSalary'
    | 'livingAllowance'
    | 'lumpSumSalary'
    | 'responsibilityAllowance'
    | 'extraEffortAllowance'
    | 'productionIncentive'
    | 'transportAllowance'
    | 'insuranceAmount'
  >
>;

export function resolveSalary(
  employee: SalarySourceEmployee,
  salaryRecord?: SalaryRecordLike | null,
): ResolvedSalary {
  const workDaysInPeriod = employee.workDaysInPeriod || 26;
  const hoursPerDay = employee.hoursPerDay || 8;

  const baseSalary = toNumber(salaryRecord?.baseSalary ?? employee.baseSalary);
  const livingAllowance = toNumber(salaryRecord?.livingAllowance ?? employee.livingAllowance);
  const lumpSumSalary = toNumber(salaryRecord?.lumpSumSalary);
  const responsibilityAllowance = toNumber(salaryRecord?.responsibilityAllowance);
  const extraEffortAllowance = toNumber(salaryRecord?.extraEffortAllowance);
  const productionIncentive = toNumber(salaryRecord?.productionIncentive);
  const transportAllowance = toNumber(salaryRecord?.transportAllowance);
  const insuranceAmount = toNumber(salaryRecord?.insuranceAmount);

  const derivedHourly =
    baseSalary > 0 && workDaysInPeriod > 0 && hoursPerDay > 0
      ? baseSalary / (workDaysInPeriod * hoursPerDay)
      : 0;
  const hourlyRate = toNumber(employee.hourlyRate) || derivedHourly;

  const monthlyTotal =
    baseSalary +
    livingAllowance +
    lumpSumSalary +
    responsibilityAllowance +
    extraEffortAllowance +
    productionIncentive +
    transportAllowance;

  return {
    baseSalary,
    livingAllowance,
    lumpSumSalary,
    responsibilityAllowance,
    extraEffortAllowance,
    productionIncentive,
    transportAllowance,
    insuranceAmount,
    hourlyRate,
    workDaysInPeriod,
    hoursPerDay,
    monthlyTotal,
  };
}

export function resolveSalaryToDecimal(
  employee: SalarySourceEmployee,
  salaryRecord?: SalaryRecordLike | null,
) {
  const resolved = resolveSalary(employee, salaryRecord);
  return {
    resolved,
    baseSalary: new Prisma.Decimal(resolved.baseSalary),
    livingAllowance: new Prisma.Decimal(resolved.livingAllowance),
    lumpSumSalary: new Prisma.Decimal(resolved.lumpSumSalary),
    responsibilityAllowance: new Prisma.Decimal(resolved.responsibilityAllowance),
    extraEffortAllowance: new Prisma.Decimal(resolved.extraEffortAllowance),
    productionIncentive: new Prisma.Decimal(resolved.productionIncentive),
    transportAllowance: new Prisma.Decimal(resolved.transportAllowance),
    insuranceAmount: new Prisma.Decimal(resolved.insuranceAmount),
    hourlyRate: new Prisma.Decimal(resolved.hourlyRate.toFixed(2)),
  };
}

/** Keep legacy Employee columns in sync with EmployeeSalary (canonical store). */
export function buildEmployeeSalaryMirror(resolved: ResolvedSalary): Prisma.EmployeeUpdateInput {
  return {
    baseSalary: new Prisma.Decimal(resolved.baseSalary),
    livingAllowance: new Prisma.Decimal(resolved.livingAllowance),
    hourlyRate: new Prisma.Decimal(resolved.hourlyRate.toFixed(2)),
  };
}

export function countPaidLeaveDaysInPeriod(
  leaves: Array<{ startDate: Date; endDate: Date }>,
  periodStart: string,
  periodEnd: string,
): number {
  const periodStartDate = new Date(`${periodStart.slice(0, 10)}T00:00:00.000Z`);
  const periodEndDate = new Date(`${periodEnd.slice(0, 10)}T00:00:00.000Z`);

  return leaves.reduce((sum, leave) => {
    const overlapStart =
      leave.startDate > periodStartDate ? leave.startDate : periodStartDate;
    const overlapEnd = leave.endDate < periodEndDate ? leave.endDate : periodEndDate;
    const ms = overlapEnd.getTime() - overlapStart.getTime();
    const days = Math.floor(ms / 86_400_000) + 1;
    return sum + (Number.isFinite(days) && days > 0 ? days : 0);
  }, 0);
}
