/**
 * CSV cells that are safe to open in Excel, Numbers or Google Sheets.
 * Text starting with = + - @ (or a tab / carriage return) would run as a
 * formula, so it gets a leading apostrophe. Plain numbers, including negative
 * ones, are left alone.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^-?\d+(\.\d+)?$/;

export function neutralizeFormula(v: unknown): string {
  const s = String(v ?? "");
  return FORMULA_START.test(s) && !NUMBER.test(s) ? `'${s}` : s;
}

export function csvCell(v: unknown): string {
  const s = neutralizeFormula(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Undo neutralizeFormula when reading our own export back in. */
export function unneutralize(s: string): string {
  return s.length > 1 && s[0] === "'" && FORMULA_START.test(s.slice(1)) ? s.slice(1) : s;
}
