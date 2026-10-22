import { SetMetadata } from '@nestjs/common';

export const REQUIRES_PAGE_KEY = 'requires_page';

/**
 * Marks a controller (or one handler) as belonging to an entitled page.
 *
 * Enforcement happens server-side in PageAccessGuard: a factory that has not
 * been sold this page is refused at the API, not merely steered away in the
 * nav. Hiding a link is a courtesy; this is the control.
 *
 * ── Why it accepts a list ───────────────────────────────────────────────────
 * A page can be reached by more than one route. The purchasing area is the
 * live example: the rename turned "أوامر الشراء" into "فاتورة شراء", and the
 * area now has two routes (`/purchasing` and `/purchasing/invoices`) that
 * serve the same entitlement. Listing both keys says "either one grants
 * access", so a factory sold the old single page keeps working and a factory
 * sold the renamed one gains it — without a migration of anyone's
 * entitlements.
 */
export const RequiresPage = (pageKey: string | string[]) =>
  SetMetadata(REQUIRES_PAGE_KEY, pageKey);
