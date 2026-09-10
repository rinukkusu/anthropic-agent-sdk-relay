/**
 * A base URL configured with a trailing slash arrives as `//v1/messages`, which
 * is a confusing 404 to debug from inside n8n. Collapse the repeats instead.
 */
export function normalizePath(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
}
