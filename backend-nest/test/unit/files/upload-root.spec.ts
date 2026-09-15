import { resolve, sep } from 'path';
import { resolveUploadRoot } from '../../../src/files/files.service';

/*
 * Uploads used to be written to `<cwd>/tmp/uploads`, inside the container image.
 * On any container host that directory is recreated empty on every redeploy, so
 * every uploaded document silently disappeared — and nothing in the code path
 * differed, so the loss only surfaced the next time someone opened an old file.
 *
 * These tests pin the guard: in production the location must be a real volume,
 * and anything that is quietly ephemeral is refused at startup rather than
 * accepted and lost later.
 */
describe('resolveUploadRoot', () => {
  const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
  const DEV = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

  describe('in production', () => {
    it('refuses to start when no location is configured', () => {
      expect(() => resolveUploadRoot(PROD)).toThrow(/UPLOAD_ROOT must be set/);
    });

    it('refuses a path inside the application directory', () => {
      // The same trap wearing a different name: still in the image, still wiped.
      const inside = resolve(process.cwd(), 'tmp', 'uploads');
      expect(() => resolveUploadRoot({ ...PROD, UPLOAD_ROOT: inside })).toThrow(
        /inside the application directory/,
      );
    });

    it('refuses the application directory itself', () => {
      expect(() =>
        resolveUploadRoot({ ...PROD, UPLOAD_ROOT: process.cwd() }),
      ).toThrow(/inside the application directory/);
    });

    it('accepts a path outside the application directory', () => {
      const mounted = resolve(sep, 'data', 'uploads');
      expect(resolveUploadRoot({ ...PROD, UPLOAD_ROOT: mounted })).toBe(mounted);
    });

    it('accepts a sibling that merely starts with the same characters', () => {
      // `<cwd>-data` is not inside `<cwd>`; only a separator boundary counts.
      const sibling = `${process.cwd()}-data`;
      expect(resolveUploadRoot({ ...PROD, UPLOAD_ROOT: sibling })).toBe(sibling);
    });

    it('ignores surrounding whitespace rather than treating it as configured', () => {
      expect(() => resolveUploadRoot({ ...PROD, UPLOAD_ROOT: '   ' })).toThrow(
        /UPLOAD_ROOT must be set/,
      );
    });
  });

  describe('outside production', () => {
    it('falls back to the working directory, where losing it costs nothing', () => {
      expect(resolveUploadRoot(DEV)).toBe(resolve(process.cwd(), 'tmp', 'uploads'));
    });

    it('still honours an explicit location', () => {
      const custom = resolve(sep, 'var', 'tmp', 'factory-uploads');
      expect(resolveUploadRoot({ ...DEV, UPLOAD_ROOT: custom })).toBe(custom);
    });

    it('permits an in-app path, unlike production', () => {
      const inside = resolve(process.cwd(), 'tmp', 'uploads');
      expect(resolveUploadRoot({ ...DEV, UPLOAD_ROOT: inside })).toBe(inside);
    });
  });
});
