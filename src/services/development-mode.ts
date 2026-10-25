/**
 * Single switch for developer-only behavior (owner decision, 2026-10-25).
 *
 * `DEVELOPMENT=TRUE` (case-insensitive) turns on diagnostics and tools meant for
 * people building and testing the platform: technical failure details in the
 * chat, and the role switcher that lets a developer act with fewer privileges
 * than they really hold. Any other value, or no value, means off.
 *
 * Server-side only: the variable has no `NEXT_PUBLIC_` prefix, so client bundles
 * never see it. Pass the result down as a prop when a component needs it. Never
 * set it in a production or pilot environment.
 */
export function isDevelopmentMode(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.DEVELOPMENT?.trim().toLowerCase() === 'true';
}
