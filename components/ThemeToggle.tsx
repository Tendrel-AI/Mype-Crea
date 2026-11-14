'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

/**
 * Light/dark switch. The initial class on <html> is set before paint by the inline script in
 * app/layout.tsx (saved choice in localStorage `theme`, else the OS preference).
 */
export function ThemeToggle({ showLabel = true, className = '' }: { showLabel?: boolean; className?: string }) {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);

  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch { /* private mode: still toggles for this page */ }
    setDark(next);
  };

  const label = dark ? 'Modo claro' : 'Modo oscuro';
  return (
    <button type="button" onClick={toggle} title={label} aria-label={label} className={className}>
      {dark ? <Sun className="w-5 h-5 flex-shrink-0" /> : <Moon className="w-5 h-5 flex-shrink-0" />}
      {showLabel && <span className="font-medium whitespace-nowrap">{label}</span>}
    </button>
  );
}
