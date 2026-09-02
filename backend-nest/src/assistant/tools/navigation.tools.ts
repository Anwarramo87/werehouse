import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AssistantTool } from '../assistant.types';

/**
 * The dashboard routes the assistant may send someone to.
 *
 * This is an allow-list on purpose. The model cannot invent a path, so it can
 * never navigate the browser somewhere that does not exist -- or somewhere
 * outside the app.
 */
export const DASHBOARD_ROUTES = [
  '/home',
  '/employees',
  '/attendance',
  '/salaries',
  '/inventory',
  '/inventory/movements',
  '/inventory/warehouses',
  '/resigned',
  '/Transportation',
  '/importData',
  '/vouchers',
  '/trash',
  '/settings',
] as const;

const ROUTE_PURPOSE: Record<(typeof DASHBOARD_ROUTES)[number], string> = {
  '/home': 'dashboard overview',
  '/employees': 'employee list and profiles',
  '/attendance': 'attendance records and daily logs',
  '/salaries': 'salaries and payroll runs',
  '/inventory': 'product catalogue and stock levels',
  '/inventory/movements': 'stock movement ledger',
  '/inventory/warehouses': 'warehouses',
  '/resigned': 'resigned and terminated employees',
  '/Transportation': 'buses and passenger assignments',
  '/importData': 'data import jobs',
  '/vouchers': 'sales orders and vouchers',
  '/trash': 'deleted records',
  '/settings': 'system settings',
};

@Injectable()
export class NavigationTools {
  tools(): AssistantTool[] {
    return [this.navigate()];
  }

  private navigate(): AssistantTool {
    void ROUTE_PURPOSE; // in-code documentation of what each route shows
    const input = z.object({
      // The enum values are self-describing paths, so they carry their own
      // documentation. Spelling each one out again cost ~900 bytes on every
      // model call, which against a tokens-per-minute budget is real money.
      route: z.enum(DASHBOARD_ROUTES),
      search: z
        .string()
        .max(120)
        .optional()
        .describe('Pre-fills the search box on that page: a staff number or SKU.'),
      reason: z.string().max(200).describe('One short sentence: why go there.'),
    });

    return {
      name: 'navigate',
      description:
        'Open a dashboard page for the user. Use when they ask to be taken somewhere, or when a page shows the answer better. Still answer in words too.',
      input,
      permissions: [],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        return {
          navigated: true,
          route: args.route,
          params: args.search ? { search: args.search } : undefined,
          reason: args.reason,
        };
      },
    };
  }
}
