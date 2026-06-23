/** Factory timezone — Saudi Arabia (UTC+3). Override via APP_TIMEZONE_OFFSET_MINUTES. */
export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 180;

export function resolveTimezoneOffsetMinutes(configured?: string | number): number {
  if (configured === undefined || configured === null || configured === '') {
    return DEFAULT_TIMEZONE_OFFSET_MINUTES;
  }

  const parsed = Number(configured);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TIMEZONE_OFFSET_MINUTES;
  }

  return Math.trunc(parsed);
}

/** Current instant shifted to factory local calendar (for date-key extraction). */
export function getFactoryLocalDate(now = new Date(), offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES): Date {
  return new Date(now.getTime() + offsetMinutes * 60_000);
}

/** YYYY-MM-DD in factory local timezone. */
export function toFactoryDateKey(now = new Date(), offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES): string {
  const local = getFactoryLocalDate(now, offsetMinutes);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Minutes since local midnight from a UTC timestamp stored in DB. */
export function utcTimestampToLocalMinutes(
  timestamp: Date,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
): number {
  const utcMinutes = timestamp.getUTCHours() * 60 + timestamp.getUTCMinutes();
  return (
    ((utcMinutes + offsetMinutes) % (24 * 60)) + 24 * 60
  ) % (24 * 60);
}

/** HH:mm display string in factory local time. */
export function formatFactoryLocalTime(
  timestamp: Date,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
): string {
  const totalMinutes = utcTimestampToLocalMinutes(timestamp, offsetMinutes);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Day-of-week (0=Sun) for a YYYY-MM-DD date key in factory timezone. */
export function factoryDateKeyDayOfWeek(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** Parse YYYY-MM-DD to UTC midnight Date for Prisma @db.Date fields. */
export function parseDateKeyToUtcMidnight(dateKey: string): Date {
  return new Date(`${dateKey.slice(0, 10)}T00:00:00.000Z`);
}

/** First/last day of calendar month as YYYY-MM-DD (factory uses UTC date keys). */
export function monthDateRange(year: number, monthIndex: number): { start: string; end: string } {
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}
