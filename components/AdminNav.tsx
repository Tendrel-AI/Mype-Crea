import Link from 'next/link';
import { ThemeToggle } from './ThemeToggle';

export const ADMIN_NAV_LINKS = [
  { href: '/admin/accounts', label: 'Cuentas' },
  { href: '/admin/limits', label: 'Límites' },
  { href: '/admin/credits', label: 'Créditos' },
  { href: '/admin/analytics', label: 'Analítica' },
  { href: '/admin/forecast', label: 'Pronóstico' },
  { href: '/admin/ai', label: 'IA' },
] as const;

/** Shared navigation of the tenant admin area (rendered by app/admin/layout.tsx). */
export default function AdminNav() {
  return (
    <nav aria-label="Administración" className="border-b bg-white">
      <ul className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-5 py-3 text-sm">
        {ADMIN_NAV_LINKS.map((l) => <li key={l.href}><Link href={l.href} className="underline">{l.label}</Link></li>)}
        <li className="ml-auto"><ThemeToggle showLabel={false} className="flex rounded p-1 text-neutral-500 hover:bg-neutral-100" /></li>
      </ul>
    </nav>
  );
}
