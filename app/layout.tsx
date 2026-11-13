import type {Metadata} from 'next';
import { AuthKitProvider } from '@workos-inc/authkit-nextjs/components';
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
    // suppressHydrationWarning: the theme script below adds `dark` to <html> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`,
          }}
        />
      </head>
      <body suppressHydrationWarning>
        <AuthKitProvider>
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
          {roleSwitcher && <DevRoleSwitcher state={roleSwitcher} />}
        </AuthKitProvider>
      </body>
    </html>
  );
}
