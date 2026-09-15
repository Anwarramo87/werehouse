import { SetMetadata } from '@nestjs/common';

export const REQUIRES_PAGE_KEY = 'requires_page';

/**
 * Marks a controller (or one handler) as belonging to an entitled page.
 *
 * Enforcement happens server-side in PageAccessGuard: a factory that has not
 * been sold this page is refused at the API, not merely steered away in the
 * nav. Hiding a link is a courtesy; this is the control.
 */
export const RequiresPage = (pageKey: string) => SetMetadata(REQUIRES_PAGE_KEY, pageKey);
