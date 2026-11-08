'use client';

import React, { useEffect, useId, useRef } from 'react';

/** A modal dialog for the brand/product forms: Escape closes it, focus moves into it. */
export function FormModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm">
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="my-8 w-full max-w-2xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl focus:outline-none">
        <h2 id={titleId} className="mb-4 text-lg font-bold text-neutral-900">{title}</h2>
        {children}
      </div>
    </div>
  );
}
