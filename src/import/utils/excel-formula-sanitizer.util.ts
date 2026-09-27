/**
 * Utility to prevent Formula Injection (CWE-1236, Lesson L-07).
 * Prepends a single quote `'` to any string cell value starting with `=, +, -, @`.
 */
export class ExcelFormulaSanitizer {
  static sanitize(value: unknown): string {
    if (value === null || value === undefined) return '';
    const str = String(value);
    const trimmed = str.trim();
    if (/^[=+\-@]/.test(trimmed)) {
      return `'${str}`;
    }
    return str;
  }

  static isFormula(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    return /^[=+\-@]/.test(String(value).trim());
  }
}
