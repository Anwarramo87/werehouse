export type AuthenticatedUser = {
  userId: string;
  username?: string;
  email?: string;
  role?: string;
  roles?: string[];
  permissions?: string[];
  /** Factory this principal belongs to. null for the super admin. */
  tenantId?: string | null;
  iat?: number;
  exp?: number;
};
