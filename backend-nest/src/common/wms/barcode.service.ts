import { Injectable } from '@nestjs/common';

export type LabelKind = 'product' | 'batch' | 'bin' | 'package' | 'shipment';

export interface BatchLabel {
  kind: 'batch';
  /** The scannable payload — this is what goes into the Code128 symbol. */
  barcode: string;
  /** GS1-style element string, for scanners configured to parse AIs. */
  gs1: string;
  sku: string;
  productName: string;
  batchNumber: string;
  productionDate: string | null;
  expiryDate: string | null;
  quantity: number;
  unit: string;
  /** Ready-to-render SVG of the Code128 symbol. */
  svg: string;
}

/**
 * Barcode encoding and label payloads.
 *
 * Code128-B is rendered here rather than pulled from a library: the alphabet
 * we emit (upper-case alphanumerics, `-`, `.`, `/`) is a strict subset of
 * set B, and a self-contained encoder keeps label printing free of a runtime
 * dependency that would also have to be present in the mobile client.
 */
@Injectable()
export class BarcodeService {
  /** Code128 set B: value = charCode - 32 for every printable ASCII char. */
  private static readonly START_B = 104;
  private static readonly STOP = 106;

  // prettier-ignore
  private static readonly PATTERNS = [
    '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100','10011001000','10011000100','10001100100','11001001000',
    '11001000100','11000100100','10110011100','10011011100','10011001110','10111001100','10011101100','10011100110','11001110010','11001011100',
    '11001001110','11011100100','11001110100','11101101110','11101001100','11100101100','11100100110','11101100100','11100110100','11100110010',
    '11011011000','11011000110','11000110110','10100011000','10001011000','10001000110','10110001000','10001101000','10001100010','11010001000',
    '11000101000','11000100010','10110111000','10110001110','10001101110','10111011000','10111000110','10001110110','11101110110','11010001110',
    '11000101110','11011101000','11011100010','11011101110','11101011000','11101000110','11100010110','11101101000','11101100010','11100011010',
    '11101111010','11001000010','11110001010','10100110000','10100001100','10010110000','10010000110','10000101100','10000100110','10110010000',
    '10110000100','10011010000','10011000010','10000110100','10000110010','11000010010','11001010000','11110111010','11000010100','10001111010',
    '10100111100','10010111100','10010011110','10111100100','10011110100','10011110010','11110100100','11110010100','11110010010','11011011110',
    '11011110110','11110110110','10101111000','10100011110','10001011110','10111101000','10111100010','11110101000','11110100010','10111011110',
    '10111101110','11101011110','11110101110','11010000100','11010010000','11010011100','11000111010',
  ];

  /**
   * Normalises free text into the Code128-B subset we print. Anything outside
   * it (Arabic product names, spaces) would still encode, but would not
   * survive the cheap scanners used on the floor, so it is stripped here
   * rather than producing a label that reads back wrong.
   */
  normalize(value: string): string {
    return value
      .toUpperCase()
      .replace(/[^A-Z0-9\-./]/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, 48);
  }

  /**
   * Batch barcode: `<SKU>-<BATCH>-<YYMMDD expiry>`.
   * Self-describing on purpose — a scan still identifies the goods when the
   * network is down and the app cannot look the id up.
   */
  batchBarcode(sku: string, batchNumber: string, expiryDate?: Date | null): string {
    const parts = [this.normalize(sku), this.normalize(batchNumber)];
    if (expiryDate) parts.push(this.yymmdd(expiryDate));
    return parts.join('-');
  }

  /** GS1 element string: (01) GTIN-ish, (10) batch, (11) production, (17) expiry. */
  gs1(sku: string, batchNumber: string, productionDate?: Date | null, expiryDate?: Date | null) {
    let out = `(01)${this.normalize(sku)}`;
    if (productionDate) out += `(11)${this.yymmdd(productionDate)}`;
    if (expiryDate) out += `(17)${this.yymmdd(expiryDate)}`;
    out += `(10)${this.normalize(batchNumber)}`;
    return out;
  }

  /**
   * Parses what a handheld scanner sends back. Accepts either our own
   * `SKU-BATCH-YYMMDD` payload or a GS1 element string, so the mobile app can
   * pass the raw scan straight through without knowing which it got.
   */
  parse(scanned: string): { sku?: string; batchNumber?: string; expiryDate?: string; raw: string } {
    const raw = scanned.trim();

    if (raw.includes('(01)') || raw.includes('(10)')) {
      const pick = (ai: string) => {
        const m = raw.match(new RegExp(`\\(${ai}\\)([^(]*)`));
        return m ? m[1] : undefined;
      };
      const expiryRaw = pick('17');
      return {
        sku: pick('01'),
        batchNumber: pick('10'),
        expiryDate: expiryRaw ? this.fromYymmdd(expiryRaw) : undefined,
        raw,
      };
    }

    const parts = raw.split('-');
    if (parts.length >= 3 && /^\d{6}$/.test(parts[parts.length - 1])) {
      const expiry = parts.pop() as string;
      const batchNumber = parts.pop();
      return { sku: parts.join('-'), batchNumber, expiryDate: this.fromYymmdd(expiry), raw };
    }

    return { sku: raw, raw };
  }

  /** Code128-B symbol as an inline SVG string, ready to embed in a label. */
  svg(value: string, opts?: { height?: number; moduleWidth?: number; showText?: boolean }): string {
    const text = this.normalize(value);
    const height = opts?.height ?? 60;
    const moduleWidth = opts?.moduleWidth ?? 2;
    const showText = opts?.showText ?? true;
    const textHeight = showText ? 16 : 0;

    const codes: number[] = [BarcodeService.START_B];
    for (const ch of text) codes.push(ch.charCodeAt(0) - 32);

    // Checksum: start value plus each symbol weighted by its position, mod 103.
    let checksum = BarcodeService.START_B;
    for (let i = 1; i < codes.length; i++) checksum += codes[i] * i;
    codes.push(checksum % 103);
    codes.push(BarcodeService.STOP);

    const bits = codes.map((c) => BarcodeService.PATTERNS[c]).join('') + '11';

    let x = 0;
    const bars: string[] = [];
    for (let i = 0; i < bits.length; ) {
      const bit = bits[i];
      let run = 0;
      while (i < bits.length && bits[i] === bit) {
        run++;
        i++;
      }
      const width = run * moduleWidth;
      if (bit === '1') {
        bars.push(`<rect x="${x}" y="0" width="${width}" height="${height}" fill="#000"/>`);
      }
      x += width;
    }

    const totalHeight = height + textHeight;
    const label = showText
      ? `<text x="${x / 2}" y="${height + 13}" font-family="monospace" font-size="12" text-anchor="middle" fill="#000">${this.escape(text)}</text>`
      : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="${totalHeight}" viewBox="0 0 ${x} ${totalHeight}"><rect width="${x}" height="${totalHeight}" fill="#fff"/>${bars.join('')}${label}</svg>`;
  }

  private yymmdd(date: Date): string {
    const d = new Date(date);
    return (
      String(d.getUTCFullYear() % 100).padStart(2, '0') +
      String(d.getUTCMonth() + 1).padStart(2, '0') +
      String(d.getUTCDate()).padStart(2, '0')
    );
  }

  private fromYymmdd(value: string): string | undefined {
    if (!/^\d{6}$/.test(value)) return undefined;
    const yy = Number(value.slice(0, 2));
    const year = yy < 70 ? 2000 + yy : 1900 + yy;
    return `${year}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
  }

  private escape(value: string): string {
    return value.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string);
  }
}
