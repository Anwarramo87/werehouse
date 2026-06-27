/**
 * ثوابت نظام المصادقة
 * تمركز كل الأرقام الثابتة المستخدمة في Auth
 */

/** الحد الافتراضي لمحاولات الدخول الفاشلة قبل القفل */
export const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;

/** مدة قفل الحساب الافتراضية بالدقائق */
export const DEFAULT_LOCKOUT_MINUTES = 15;

/** عدد جولات bcrypt الافتراضي */
export const BCRYPT_DEFAULT_ROUNDS = 12;

/** مدة انتهاء JWT الافتراضية */
export const JWT_DEFAULT_EXPIRE = '15m';

/** TTL for cached JWT user lookups (seconds) */
export const JWT_USER_CACHE_TTL_SECONDS = 60;

/** Default refresh token lifetime in days */
export const JWT_REFRESH_DAYS_DEFAULT = 7;

/** Default refresh cookie name */
export const JWT_REFRESH_COOKIE_NAME_DEFAULT = 'warehouse_refresh_token';

/** عدد البايتات العشوائية للـ biometric challenge */
export const BIOMETRIC_CHALLENGE_BYTES = 32;

/** مدة صلاحية الـ biometric challenge بالثواني */
export const BIOMETRIC_CHALLENGE_TTL_SECONDS = 120;

/** عتبة تجديد الـ token تلقائياً (بالثواني قبل انتهاء الصلاحية) */
export const AUTO_REFRESH_THRESHOLD_SECONDS = 300;

/** مدة الـ fallback لإلغاء التوكن في الذاكرة (بالميلي ثانية) */
export const TOKEN_REVOCATION_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
