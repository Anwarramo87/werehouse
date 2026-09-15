export type AuthenticatedUser = {
  userId: string;
  username?: string;
  email?: string;
  role?: string;
  roles?: string[];
  permissions?: string[];
  /** Factory this principal belongs to. null for the super admin. */
  tenantId?: string | null;
  /**
   * The employee record this login belongs to, when there is one.
   *
   * Present so that "my own record" is provable from a verified token instead
   * of being read out of the request URL. Null for accounts that are not staff
   * members -- the super admin, and any operator account with no Employee row.
   */
  employeeId?: string | null;
  iat?: number;
  exp?: number;
};
