require('dotenv/config');

const fs = require('fs');
const path = require('path');
const { parse: parseCsv } = require('csv-parse/sync');
const XLSX = require('xlsx');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const DEFAULT_START_CODE = 900009;
const DEFAULT_WORK_DAYS = 26;
const DEFAULT_HOURS_PER_DAY = 8;
const DEFAULT_GRACE_PERIOD = 5;
const DEFAULT_SCHEDULED_START = '08:00';
const DEFAULT_SCHEDULED_END = '17:00';
const SUPPORTED_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.xlsx', '.xls', '.xlsm', '.xlsb', '.ods']);

const HEADER_ALIASES = {
  biometricNumber: ['رقم الموظف', 'الرقم', 'رقم'],
  name: ['الاسم', 'اسم الموظف', 'اسم'],
  profession: ['المهنة', 'المسمى الوظيفي', 'الوظيفة'],
  department: ['القسم', 'الادارة', 'الإدارة'],
  baseSalary: ['الراتب الأساسي', 'الراتب الاساسي', 'الراتب'],
  livingAllowance: ['بدل غلاء معيشة', 'بدل غلاء المعيشة'],
  residence: ['مكان السكن', 'السكن', 'الإقامة', 'الاقامة', 'مكان الاقامة', 'مكان الإقامة'],
};

function parseArgs(argv) {
  const args = {
    startCode: DEFAULT_START_CODE,
    dryRun: false,
    file: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--file') {
      args.file = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--start-code') {
      args.startCode = Number(argv[index + 1]);
      index += 1;
      continue;
    }
  }

  if (!Number.isInteger(args.startCode) || args.startCode < 0) {
    throw new Error('--start-code must be a positive integer');
  }

  return args;
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s_\-./\\()]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function normalizeText(value) {
  const text = String(value ?? '').replace(/\u00A0/g, ' ').trim();
  return text || null;
}

function parseFlexibleNumber(rawValue) {
  let normalized = String(rawValue ?? '')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))
    .trim();

  if (!normalized) {
    return null;
  }

  normalized = normalized
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[^\d.,+\-]/g, '');

  if (!normalized || /^[-+]?([.,])?$/.test(normalized)) {
    return null;
  }

  const commaCount = (normalized.match(/,/g) || []).length;
  const dotCount = (normalized.match(/\./g) || []).length;

  if (commaCount > 0 && dotCount > 0) {
    if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
      normalized = normalized.replace(/\./g, '').replace(/,/g, '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if (commaCount > 0) {
    if (commaCount > 1) {
      normalized = normalized.replace(/,/g, '');
    } else {
      const commaIndex = normalized.indexOf(',');
      const fractionLength = normalized.length - commaIndex - 1;
      const integerLength = commaIndex;
      if (fractionLength === 3 && integerLength >= 1) {
        normalized = normalized.replace(/,/g, '');
      } else {
        normalized = normalized.replace(',', '.');
      }
    }
  } else if (dotCount > 1) {
    normalized = normalized.replace(/\./g, '');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function detectDelimiter(content) {
  const firstLine = (content.split(/\r?\n/, 1)[0] || '').trim();
  const candidates = ['\t', ',', ';', '|'];
  let bestDelimiter = ',';
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = firstLine.split(candidate).length - 1;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = candidate;
    }
  }

  return bestScore > 0 ? bestDelimiter : ',';
}

function toRowsFromDelimited(content) {
  const parsed = parseCsv(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    delimiter: detectDelimiter(content),
  });

  return parsed
    .map((row) => {
      const normalizedRow = {};
      for (const [key, value] of Object.entries(row)) {
        normalizedRow[normalizeHeader(key)] = String(value ?? '').trim();
      }
      return normalizedRow;
    })
    .filter((row) => Object.values(row).some((value) => value !== ''));
}

function toRowsFromSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    raw: false,
    cellDates: false,
    dense: true,
  });

  const firstSheetName = workbook.SheetNames && workbook.SheetNames[0];
  if (!firstSheetName) {
    return [];
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const matrix = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });

  if (!Array.isArray(matrix) || matrix.length === 0) {
    return [];
  }

  const headers = Array.isArray(matrix[0]) ? matrix[0].map((cell) => normalizeHeader(cell)) : [];

  return matrix
    .slice(1)
    .map((cells) => {
      const normalizedRow = {};
      headers.forEach((header, index) => {
        normalizedRow[header] = String((Array.isArray(cells) ? cells[index] : '') ?? '').trim();
      });
      return normalizedRow;
    })
    .filter((row) => Object.values(row).some((value) => value !== ''));
}

function resolveInputFile(customFile) {
  if (customFile) {
    return path.resolve(customFile);
  }

  const dataDirectory = path.resolve(__dirname, '..', 'prisma', 'data');
  if (!fs.existsSync(dataDirectory)) {
    throw new Error(`Data directory not found: ${dataDirectory}`);
  }

  const candidates = fs
    .readdirSync(dataDirectory)
    .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(dataDirectory, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`No supported data file found in ${dataDirectory}`);
  }

  return candidates[0];
}

function loadRows(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported file type: ${extension}`);
  }

  const buffer = fs.readFileSync(filePath);
  if (['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods'].includes(extension)) {
    return toRowsFromSpreadsheet(buffer);
  }

  return toRowsFromDelimited(buffer.toString('utf8'));
}

function pickValue(row, aliases) {
  for (const alias of aliases) {
    const value = row[normalizeHeader(alias)];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return '';
}

function formatEmployeeCode(sequenceNumber) {
  return `EMP${String(sequenceNumber).padStart(6, '0')}`;
}

function mapRow(row, rowIndex, startCode) {
  const biometricNumber = parseFlexibleNumber(pickValue(row, HEADER_ALIASES.biometricNumber));
  const name = normalizeText(pickValue(row, HEADER_ALIASES.name));

  if (!biometricNumber || !Number.isInteger(biometricNumber)) {
    throw new Error('Missing or invalid old biometric number');
  }

  if (!name) {
    throw new Error('Missing employee name');
  }

  const baseSalary = parseFlexibleNumber(pickValue(row, HEADER_ALIASES.baseSalary));
  const livingAllowance = parseFlexibleNumber(pickValue(row, HEADER_ALIASES.livingAllowance));
  const profession = normalizeText(pickValue(row, HEADER_ALIASES.profession));
  const department = normalizeText(pickValue(row, HEADER_ALIASES.department)) || 'Warehouse';
  const residence = normalizeText(pickValue(row, HEADER_ALIASES.residence));
  const employeeId = formatEmployeeCode(startCode + rowIndex);
  const hourlyRate = baseSalary
    ? Number((baseSalary / (DEFAULT_WORK_DAYS * DEFAULT_HOURS_PER_DAY)).toFixed(2))
    : 0;

  return {
    biometricNumber,
    employeeId,
    name,
    profession,
    department,
    residence,
    baseSalary,
    livingAllowance,
    hourlyRate,
  };
}

async function resolveDepartment(tx, departmentName) {
  const existing = await tx.department.findFirst({
    where: {
      name: {
        equals: departmentName,
        mode: 'insensitive',
      },
    },
  });

  if (existing) {
    return existing;
  }

  return tx.department.create({
    data: { name: departmentName },
  });
}

async function resolveRoleId(tx) {
  const existing = await tx.role.findFirst({
    where: { name: { in: ['staff', 'admin'] } },
    orderBy: { createdAt: 'asc' },
  });

  if (existing) {
    return existing.id;
  }

  const created = await tx.role.create({
    data: {
      name: 'staff',
      description: 'Default staff role for imported employees',
      permissions: [],
    },
  });

  return created.id;
}

async function upsertEmployee(prisma, row) {
  const conflictByBiometric = await prisma.employee.findUnique({
    where: { biometricNumber: row.biometricNumber },
    select: { employeeId: true, biometricNumber: true, employmentStartDate: true },
  });

  if (conflictByBiometric && conflictByBiometric.employeeId !== row.employeeId) {
    throw new Error(
      `Biometric number ${row.biometricNumber} already belongs to ${conflictByBiometric.employeeId}`,
    );
  }

  const conflictByEmployeeId = await prisma.employee.findUnique({
    where: { employeeId: row.employeeId },
    select: { employeeId: true, biometricNumber: true, employmentStartDate: true },
  });

  if (
    conflictByEmployeeId &&
    conflictByEmployeeId.biometricNumber !== null &&
    conflictByEmployeeId.biometricNumber !== row.biometricNumber
  ) {
    throw new Error(
      `Employee code ${row.employeeId} already belongs to biometric number ${conflictByEmployeeId.biometricNumber}`,
    );
  }

  const employmentStartDate =
    conflictByEmployeeId?.employmentStartDate ??
    conflictByBiometric?.employmentStartDate ??
    new Date();

  const roleId = await resolveRoleId(prisma);
  const department = await resolveDepartment(prisma, row.department);

  await prisma.employee.upsert({
    where: { employeeId: row.employeeId },
    update: {
      biometricNumber: row.biometricNumber,
      name: row.name,
      residence: row.residence,
      jobTitle: row.profession,
      profession: row.profession,
      hourlyRate: new Prisma.Decimal(row.hourlyRate),
      baseSalary: row.baseSalary != null ? new Prisma.Decimal(row.baseSalary) : null,
      livingAllowance: row.livingAllowance != null ? new Prisma.Decimal(row.livingAllowance) : null,
      roleId,
      department: department.name,
      departmentId: department.id,
      status: 'active',
      scheduledStart: DEFAULT_SCHEDULED_START,
      scheduledEnd: DEFAULT_SCHEDULED_END,
      employmentStartDate,
      workDaysInPeriod: DEFAULT_WORK_DAYS,
      hoursPerDay: DEFAULT_HOURS_PER_DAY,
      gracePeriodMinutes: DEFAULT_GRACE_PERIOD,
    },
    create: {
      employeeId: row.employeeId,
      biometricNumber: row.biometricNumber,
      name: row.name,
      residence: row.residence,
      jobTitle: row.profession,
      profession: row.profession,
      hourlyRate: new Prisma.Decimal(row.hourlyRate),
      baseSalary: row.baseSalary != null ? new Prisma.Decimal(row.baseSalary) : null,
      livingAllowance: row.livingAllowance != null ? new Prisma.Decimal(row.livingAllowance) : null,
      roleId,
      department: department.name,
      departmentId: department.id,
      status: 'active',
      scheduledStart: DEFAULT_SCHEDULED_START,
      scheduledEnd: DEFAULT_SCHEDULED_END,
      employmentStartDate,
      workDaysInPeriod: DEFAULT_WORK_DAYS,
      hoursPerDay: DEFAULT_HOURS_PER_DAY,
      gracePeriodMinutes: DEFAULT_GRACE_PERIOD,
    },
  });

  await prisma.employeeSalary.upsert({
    where: { employeeId: row.employeeId },
    update: {
      profession: row.profession,
      baseSalary:
        row.baseSalary != null ? new Prisma.Decimal(row.baseSalary) : new Prisma.Decimal(0),
      livingAllowance:
        row.livingAllowance != null
          ? new Prisma.Decimal(row.livingAllowance)
          : new Prisma.Decimal(0),
    },
    create: {
      employeeId: row.employeeId,
      profession: row.profession,
      baseSalary:
        row.baseSalary != null ? new Prisma.Decimal(row.baseSalary) : new Prisma.Decimal(0),
      lumpSumSalary: new Prisma.Decimal(0),
      livingAllowance:
        row.livingAllowance != null
          ? new Prisma.Decimal(row.livingAllowance)
          : new Prisma.Decimal(0),
    },
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filePath = resolveInputFile(options.file);
  const rows = loadRows(filePath);

  if (rows.length === 0) {
    throw new Error(`No rows found in ${filePath}`);
  }

  const mappedRows = rows.map((row, index) => mapRow(row, index, options.startCode));
  const duplicateBiometricNumbers = new Set();
  const seenBiometricNumbers = new Set();

  mappedRows.forEach((row) => {
    if (seenBiometricNumbers.has(row.biometricNumber)) {
      duplicateBiometricNumbers.add(row.biometricNumber);
      return;
    }
    seenBiometricNumbers.add(row.biometricNumber);
  });

  if (duplicateBiometricNumbers.size > 0) {
    throw new Error(
      `Duplicate old biometric numbers found in the source file: ${Array.from(duplicateBiometricNumbers).join(', ')}`,
    );
  }

  console.log(`Source file: ${filePath}`);
  console.log(`Rows found: ${mappedRows.length}`);
  console.log(`First employee code: ${mappedRows[0].employeeId}`);
  console.log(`Last employee code: ${mappedRows[mappedRows.length - 1].employeeId}`);

  if (options.dryRun) {
    console.log('Dry run only. Preview of first 5 rows:');
    console.table(
      mappedRows.slice(0, 5).map((row) => ({
        employeeId: row.employeeId,
        biometricNumber: row.biometricNumber,
        name: row.name,
        department: row.department,
        profession: row.profession,
        residence: row.residence,
      })),
    );
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const errors = [];
  let successCount = 0;

  try {
    for (let index = 0; index < mappedRows.length; index += 1) {
      const row = mappedRows[index];
      try {
        await upsertEmployee(prisma, row);
        successCount += 1;
      } catch (error) {
        errors.push({
          row: index + 2,
          employeeId: row.employeeId,
          biometricNumber: row.biometricNumber,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }

  console.log(`Imported successfully: ${successCount}`);
  console.log(`Failed rows: ${errors.length}`);

  if (errors.length > 0) {
    console.table(errors.slice(0, 20));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
