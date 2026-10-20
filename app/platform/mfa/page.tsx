import { redirect } from 'next/navigation';
import { requireGlobalAdmin, requireGlobalMfa } from '../../../src/auth/resolve-identity';
import { PlatformMfaForm } from './platform-mfa-form';

export default async function PlatformMfaPage() {
  try {
    await requireGlobalAdmin();
  } catch {
    redirect('/login');
  }
  let hasRecentMfa = false;
  try {
    await requireGlobalMfa();
    hasRecentMfa = true;
  } catch {
    // A missing or expired step-up proof is the expected enrollment/challenge state.
  }
  if (hasRecentMfa) redirect('/platform');
  return <PlatformMfaForm />;
}
