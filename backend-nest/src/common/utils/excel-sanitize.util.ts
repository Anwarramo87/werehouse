/**
 * Sanitize a string value before writing it into an Excel cell.
 *
 * Spreadsheet applications (Excel, LibreOffice, Google Sheets) treat any cell
 * value that starts with =, +, -, or @ as a formula.  An attacker who controls
 * employee names, notes, or other free-text fields could inject a formula that
 * exfiltrates data or executes macros when the file is opened.
 *
 * Mitigation: prefix the offending value with a single-quote (') which forces
 * the cell to be treated as plain text in all major spreadsheet applications.
 */
export function sanitizeExcelCell(value: unknown): string {
  const text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) {
    return `'${text}`;
  }
  return text;
}
