import type {Metadata} from 'next';
import './globals.css'; // Global styles
import { ErrorBoundary } from '../components/ErrorBoundary';
import { DevRoleSwitcher } from '../components/DevRoleSwitcher';
import { getRoleSwitcherState } from '../src/auth/resolve-identity';

export const metadata: Metadata = {
  title: 'CreaMype',
  description: 'Crea tu marca y lanza tu producto con IA',
};

export default async function RootLayout({children}: {children: React.ReactNode}) {
  // Developer role switcher (KAN-79): null unless DEVELOPMENT=TRUE and the user holds a role to reduce.
  const roleSwitcher = await getRoleSwitcherState();
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
        {roleSwitcher && <DevRoleSwitcher state={roleSwitcher} />}
      </body>
    </html>
  );
}
