import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LogoCard, LOGO_REFERENCE_LABEL } from '../logo-card';

const noop = () => {};
const card = (references: Array<{ id: string; name: string }>, extra: Partial<React.ComponentProps<typeof LogoCard>> = {}) =>
  renderToStaticMarkup(
    <LogoCard view={undefined} label="logo" busy={false} error="" onCommand={noop} references={references} uploading={false} onUpload={noop} onRemove={noop} {...extra} />,
  );

describe('LogoCard (D62)', () => {
  it('offers «Subir referencia» that accepts only raster images', () => {
    const markup = card([]);
    expect(markup).toContain(LOGO_REFERENCE_LABEL);
    expect(markup).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(markup).not.toContain('svg');
  });

  it('shows thumbnails with a remove action', () => {
    const markup = card([{ id: 'a1', name: 'estilo.png' }]);
    expect(markup).toContain('src="/api/brand-files/a1"');
    expect(markup).toContain('aria-label="Quitar referencia estilo.png"');
  });

  it('disables the upload button at three references', () => {
    const three = [1, 2, 3].map((n) => ({ id: `r${n}`, name: `r${n}.png` }));
    expect(card(three)).toMatch(/<button[^>]*disabled=""[^>]*>Subir referencia<\/button>/);
    expect(card(three.slice(0, 2))).not.toMatch(/<button[^>]*disabled=""[^>]*>Subir referencia<\/button>/);
  });
});
