import { Prisma } from '@prisma/client';
import { canonicalise, checksumOf, decodeRow, encodeRow } from './snapshot.codec';

describe('snapshot codec', () => {
  describe('encodeRow', () => {
    it('keeps Decimal precision exactly, never via Number', () => {
      // 12,345,678.91 has more significant digits than a float carries safely.
      // This is the salary-rounding failure mode the Excel export already has.
      const row = { id: 'x', netPay: new Prisma.Decimal('12345678.91') };
      const encoded = encodeRow(row);

      expect(encoded.netPay).toBe('12345678.91');
      expect(typeof encoded.netPay).toBe('string');
    });

    it('preserves trailing-zero Decimals as written', () => {
      const encoded = encodeRow({ id: 'x', amount: new Prisma.Decimal('100.00') });
      expect(encoded.amount).toBe('100');
    });

    it('encodes Dates as ISO strings', () => {
      const encoded = encodeRow({ id: 'x', createdAt: new Date('2026-08-30T10:20:30.000Z') });
      expect(encoded.createdAt).toBe('2026-08-30T10:20:30.000Z');
    });

    it('wraps Bytes so they cannot be mistaken for a string column', () => {
      const key = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      const encoded = encodeRow({ id: 'x', publicKeyDer: key });

      expect(encoded.publicKeyDer).toEqual({ $bytes: '3q2+7w==' });
    });

    it('distinguishes null from empty string', () => {
      const encoded = encodeRow({ id: 'x', a: null, b: '' });
      expect(encoded.a).toBeNull();
      expect(encoded.b).toBe('');
    });

    it('passes Json columns through untouched', () => {
      const metadata = { nested: { list: [1, 2, 3] }, flag: true };
      const encoded = encodeRow({ id: 'x', metadata });
      expect(encoded.metadata).toEqual(metadata);
    });

    it('preserves a long base64 data URL without truncation', () => {
      // Excel caps a cell at 32,767 characters; Product.photo routinely exceeds it.
      const photo = `data:image/png;base64,${'A'.repeat(60_000)}`;
      const encoded = encodeRow({ id: 'x', photo });
      expect((encoded.photo as string).length).toBe(photo.length);
    });
  });

  describe('round trip', () => {
    it('returns Bytes as a Buffer with identical contents', () => {
      const original = Buffer.from([0x00, 0x01, 0xff, 0x7f]);
      const decoded = decodeRow(encodeRow({ id: 'x', key: original }));

      expect(Buffer.isBuffer(decoded.key)).toBe(true);
      expect(Buffer.compare(decoded.key as Buffer, original)).toBe(0);
    });

    it('leaves Decimals and Dates as strings for Prisma to coerce', () => {
      const decoded = decodeRow(
        encodeRow({
          id: 'x',
          amount: new Prisma.Decimal('42.50'),
          at: new Date('2026-01-01T00:00:00.000Z'),
        }),
      );

      expect(decoded.amount).toBe('42.5');
      expect(decoded.at).toBe('2026-01-01T00:00:00.000Z');
    });

    it('survives a JSON serialise/parse cycle unchanged', () => {
      const row = encodeRow({
        id: 'x',
        amount: new Prisma.Decimal('999999.99'),
        key: Buffer.from('secret'),
        at: new Date('2026-06-15T12:00:00.000Z'),
        nothing: null,
      });

      const revived = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
      expect(revived).toEqual(row);

      const decoded = decodeRow(revived);
      expect(Buffer.isBuffer(decoded.key)).toBe(true);
      expect((decoded.key as Buffer).toString()).toBe('secret');
    });
  });

  describe('canonicalise', () => {
    it('is insensitive to key order', () => {
      expect(canonicalise({ b: 1, a: 2 })).toBe(canonicalise({ a: 2, b: 1 }));
    });

    it('is sensitive to values', () => {
      expect(canonicalise({ a: 1 })).not.toBe(canonicalise({ a: 2 }));
    });

    it('sorts keys at every depth', () => {
      const left = canonicalise({ outer: { z: 1, a: { y: 2, b: 3 } } });
      const right = canonicalise({ outer: { a: { b: 3, y: 2 }, z: 1 } });
      expect(left).toBe(right);
    });

    it('preserves array order, which is meaningful', () => {
      expect(canonicalise([1, 2])).not.toBe(canonicalise([2, 1]));
    });
  });

  describe('checksumOf', () => {
    it('is stable for equivalent payloads', () => {
      const a = { employee: [{ id: '1', name: 'Ali' }] };
      const b = { employee: [{ name: 'Ali', id: '1' }] };
      expect(checksumOf(a)).toBe(checksumOf(b));
    });

    it('changes when a single character changes', () => {
      const a = checksumOf({ employee: [{ id: '1', name: 'Ali' }] });
      const b = checksumOf({ employee: [{ id: '1', name: 'Ali ' }] });
      expect(a).not.toBe(b);
    });

    it('changes when a row is dropped', () => {
      const full = checksumOf({ employee: [{ id: '1' }, { id: '2' }] });
      const truncated = checksumOf({ employee: [{ id: '1' }] });
      expect(full).not.toBe(truncated);
    });
  });
});
