import { redirect } from 'next/navigation';
import { requireGlobalAdmin, requireGlobalMfa } from '../../../src/auth/resolve-identity';
import { safeNextPath } from '../../../src/auth/safe-next-path';
import { PlatformMfaForm } from './platform-mfa-form';

const DEFAULT_DESTINATION = '/platform';

export default async function PlatformMfaPage({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly next?: string | string[] }>;
}) {
  try {
    await requireGlobalAdmin();
  } catch {
    redirect('/login');
  }
  // Validated on the server; the form only ever receives a same-origin relative path.
  const next = safeNextPath((await searchParams)?.next, DEFAULT_DESTINATION);
  let hasRecentMfa = false;
  try {
    await requireGlobalMfa();
    hasRecentMfa = true;
  } catch {
    // A missing or expired step-up proof is the expected enrollment/challenge state.
  }
  if (hasRecentMfa) redirect(next);
  return <PlatformMfaForm next={next} />;
}
