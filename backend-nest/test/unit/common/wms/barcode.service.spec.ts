import { BarcodeService } from '../../../../src/common/wms/barcode.service';

/**
 * A label that scans back as something other than what was printed is a
 * silent, physical failure — the wrong lot ships and nothing in the system
 * objects. The round trip is therefore pinned in both directions.
 */
describe('BarcodeService', () => {
  const service = new BarcodeService();

  describe('normalize', () => {
    it('folds anything outside the Code128-B subset we print', () => {
      // Arabic product names would encode but not survive floor scanners.
      expect(service.normalize('دواء paracetamol 500')).toBe('-PARACETAMOL-500');
    });

    it('collapses runs of separators so the payload stays readable', () => {
      expect(service.normalize('a   b')).toBe('A-B');
    });

    it('caps the length so a long SKU cannot overflow the label', () => {
      expect(service.normalize('X'.repeat(200))).toHaveLength(48);
    });
  });

  describe('batchBarcode', () => {
    it('encodes SKU, batch and the expiry as YYMMDD', () => {
      const code = service.batchBarcode('MED-01', 'L2201', new Date(Date.UTC(2027, 2, 9)));
      expect(code).toBe('MED-01-L2201-270309');
    });

    it('omits the date segment when the batch has no expiry', () => {
      expect(service.batchBarcode('BOLT-9', 'B1')).toBe('BOLT-9-B1');
    });
  });

  describe('parse', () => {
    it('round-trips our own payload back to its parts', () => {
      const expiry = new Date(Date.UTC(2027, 2, 9));
      const code = service.batchBarcode('MED-01', 'L2201', expiry);

      expect(service.parse(code)).toMatchObject({
        sku: 'MED-01',
        batchNumber: 'L2201',
        expiryDate: '2027-03-09',
      });
    });

    it('reads a GS1 element string from a supplier label', () => {
      const parsed = service.parse('(01)MED-01(11)260101(17)270309(10)L2201');

      expect(parsed.sku).toBe('MED-01');
      expect(parsed.batchNumber).toBe('L2201');
      expect(parsed.expiryDate).toBe('2027-03-09');
    });

    it('treats an unstructured scan as a bare SKU rather than guessing', () => {
      const parsed = service.parse('PLAIN-SKU');
      expect(parsed.sku).toBe('PLAIN-SKU');
      expect(parsed.batchNumber).toBeUndefined();
    });

    it('does not mistake a trailing numeric SKU segment for a date', () => {
      // Three parts, but the last is not six digits, so it is not an expiry.
      const parsed = service.parse('AB-CD-12');
      expect(parsed.sku).toBe('AB-CD-12');
      expect(parsed.batchNumber).toBeUndefined();
    });
  });

  describe('svg', () => {
    it('emits a self-contained symbol sized to its content', () => {
      const svg = service.svg('MED-01-L2201');

      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).toContain('</svg>');
      // Bars are drawn as filled rects; an empty symbol would render blank.
      expect(svg.split('<rect').length).toBeGreaterThan(10);
    });

    it('keeps markup characters out of the caption entirely', () => {
      // Two layers guard this: `normalize` folds `<`, `>` and `&` to `-`
      // before they reach the caption, and `escape` catches anything that
      // ever slips past. The observable guarantee is that the emitted SVG
      // carries no injected element.
      const svg = service.svg('A<B>C&D');

      expect(svg).toContain('>A-B-C-D</text>');
      expect(svg).not.toContain('<B>');
    });

    it('omits the caption when asked for bars only', () => {
      expect(service.svg('ABC', { showText: false })).not.toContain('<text');
    });
  });
});
