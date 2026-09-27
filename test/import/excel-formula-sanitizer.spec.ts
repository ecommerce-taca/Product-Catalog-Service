import { ExcelFormulaSanitizer } from '../../src/import/utils/excel-formula-sanitizer.util';

describe('ExcelFormulaSanitizer (SG-1 CWE-1236)', () => {
  describe('sanitize', () => {
    it('should prepend single quote to formula starting with =', () => {
      expect(ExcelFormulaSanitizer.sanitize('=cmd|"/C calc"!A0')).toBe('\'=cmd|"/C calc"!A0');
    });

    it('should prepend single quote to formula starting with +', () => {
      expect(ExcelFormulaSanitizer.sanitize('+1+2')).toBe("'+1+2");
    });

    it('should prepend single quote to formula starting with -', () => {
      expect(ExcelFormulaSanitizer.sanitize('-SUM(A1:A10)')).toBe("'-SUM(A1:A10)");
    });

    it('should prepend single quote to formula starting with @', () => {
      expect(ExcelFormulaSanitizer.sanitize('@SUM(A1:B2)')).toBe("'@SUM(A1:B2)");
    });

    it('should prepend single quote to formula with leading spaces/tabs/newlines (SG-1)', () => {
      expect(ExcelFormulaSanitizer.sanitize('   =cmd|"/C calc"!A0')).toBe('\'   =cmd|"/C calc"!A0');
      expect(ExcelFormulaSanitizer.sanitize('\t+12345')).toBe("'\t+12345");
      expect(ExcelFormulaSanitizer.sanitize('\n-SUM(A1:B1)')).toBe("'\n-SUM(A1:B1)");
      expect(ExcelFormulaSanitizer.sanitize('  @AVERAGE(C1:C5)')).toBe("'  @AVERAGE(C1:C5)");
    });

    it('should leave safe values unchanged', () => {
      expect(ExcelFormulaSanitizer.sanitize('Áo thun thể thao nam')).toBe('Áo thun thể thao nam');
      expect(ExcelFormulaSanitizer.sanitize('SKU-12345')).toBe('SKU-12345');
      expect(ExcelFormulaSanitizer.sanitize('150000')).toBe('150000');
    });

    it('should return empty string for null and undefined', () => {
      expect(ExcelFormulaSanitizer.sanitize(null)).toBe('');
      expect(ExcelFormulaSanitizer.sanitize(undefined)).toBe('');
    });
  });

  describe('isFormula', () => {
    it('should return true for formula starting with =, +, -, @', () => {
      expect(ExcelFormulaSanitizer.isFormula('=SUM(A1:A2)')).toBe(true);
      expect(ExcelFormulaSanitizer.isFormula('+123')).toBe(true);
      expect(ExcelFormulaSanitizer.isFormula('-456')).toBe(true);
      expect(ExcelFormulaSanitizer.isFormula('@SUM(B1:B2)')).toBe(true);
    });

    it('should return true for formula with leading whitespace (SG-1)', () => {
      expect(ExcelFormulaSanitizer.isFormula('   =SUM(A1:A2)')).toBe(true);
      expect(ExcelFormulaSanitizer.isFormula('  +123')).toBe(true);
    });

    it('should return false for safe strings, null, and undefined', () => {
      expect(ExcelFormulaSanitizer.isFormula('Product Title')).toBe(false);
      expect(ExcelFormulaSanitizer.isFormula(null)).toBe(false);
      expect(ExcelFormulaSanitizer.isFormula(undefined)).toBe(false);
    });
  });
});
