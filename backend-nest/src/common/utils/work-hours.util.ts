/**
 * Single source of truth for the employee schedule → hoursPerDay mapping.
 *
 * scheduledStart + scheduledEnd are the ONLY editable schedule fields.
 * hoursPerDay is always DERIVED from them (never trusted from the client).
 */

/** Parse "HH:mm" into minutes-of-day. Returns null when missing/invalid. */
export function parseTimeToMinutes(value?: string | null): number | null {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Derive hoursPerDay (whole hours, min 1) from the schedule window
 * (scheduledEnd − scheduledStart). Returns null when either time is missing,
 * unparseable, or the window is not strictly positive (end <= start).
 */
export function deriveHoursPerDayFromSchedule(
  scheduledStart?: string | null,
  scheduledEnd?: string | null,
): number | null {
  const startMin = parseTimeToMinutes(scheduledStart);
  const endMin = parseTimeToMinutes(scheduledEnd);
  if (startMin === null || endMin === null) return null;
  const diffMinutes = endMin - startMin;
  if (diffMinutes <= 0) return null;
  return Math.max(1, Math.round(diffMinutes / 60));
}

/**
 * Validate that scheduledEnd is strictly after scheduledStart.
 * Returns an error message when invalid, null when valid or uncheckable
 * (either time missing/unparseable).
 */
export function validateScheduleTimes(
  scheduledStart?: string | null,
  scheduledEnd?: string | null,
): string | null {
  if (!scheduledStart || !scheduledEnd) return null;
  const startMin = parseTimeToMinutes(scheduledStart);
  const endMin = parseTimeToMinutes(scheduledEnd);
  if (startMin === null || endMin === null) return null;
  if (endMin <= startMin) return 'scheduledEnd must be after scheduledStart';
  return null;
}
