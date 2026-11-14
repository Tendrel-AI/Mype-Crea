import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LandingPageRenderer } from '../LandingPageRenderer';

describe('LandingPageRenderer', () => {
  it('renders ordered typed sections as text with a logical heading outline even without a hero', () => {
    const markup = renderToStaticMarkup(
      <LandingPageRenderer
        content={{
          format: 'typed',
          schemaVersion: 1,
          sections: [
            { kind: 'benefits', heading: '<script>Beneficios</script>', benefits: [{ heading: 'Rápido', body: 'A mano' }] },
            { kind: 'contact', heading: 'Contacto', methods: [{ label: 'Web', value: 'Tienda', url: 'https://example.com/contact' }] },
          ],
        }}
        title="preview"
        className="preview"
      />,
    );

    expect(markup.indexOf('<section')).toBeLessThan(markup.indexOf('Contacto'));
    expect(markup).toContain('<h1 class="text-2xl font-semibold">&lt;script&gt;Beneficios&lt;/script&gt;</h1>');
    expect(markup).toContain('<h2 class="font-semibold">Rápido</h2>');
    expect(markup).toContain('<h2 class="text-2xl font-semibold">Contacto</h2>');
    expect(markup).toContain('href="https://example.com/contact" target="_blank" rel="noopener noreferrer"');
    expect(markup).not.toContain('<script>');
  });

  it('renders hero, gallery, and call-to-action media and links with safe URLs and escaped text', () => {
    const markup = renderToStaticMarkup(
      <LandingPageRenderer
        content={{
          format: 'typed',
          schemaVersion: 1,
          sections: [
            {
              kind: 'hero',
              heading: '<b>Hecho a mano</b>',
              supportingText: 'Con ingredientes naturales',
              imageUrl: 'https://example.com/hero.png?size=large&crop=square',
              callToAction: { label: 'Conoce <nuestra marca>', url: 'https://example.com/about?from=hero&lang=es' },
            },
            {
              kind: 'gallery',
              heading: 'Productos',
              images: [{ imageUrl: 'https://example.com/product.png', alt: 'Jabón <cítrico>', caption: '<strong>Nuevo</strong>' }],
            },
            {
              kind: 'callToAction',
              heading: 'Haz tu pedido',
              supportingText: 'Estamos para ayudarte',
              label: 'Comprar ahora',
              url: 'https://example.com/shop?item=soap&ref=page',
            },
          ],
        }}
        title="preview"
        className="preview"
      />,
    );

    expect(markup.indexOf('Hecho a mano')).toBeLessThan(markup.indexOf('Productos'));
    expect(markup.indexOf('Productos')).toBeLessThan(markup.indexOf('Haz tu pedido'));
    expect(markup).toContain('&lt;b&gt;Hecho a mano&lt;/b&gt;');
    expect(markup).toContain('src="https://example.com/hero.png?size=large&amp;crop=square"');
    expect(markup).toContain('href="https://example.com/about?from=hero&amp;lang=es" target="_blank" rel="noopener noreferrer"');
    expect(markup).toContain('alt="Jabón &lt;cítrico&gt;"');
    expect(markup).toContain('&lt;strong&gt;Nuevo&lt;/strong&gt;');
    expect(markup).toContain('href="https://example.com/shop?item=soap&amp;ref=page" target="_blank" rel="noopener noreferrer"');
    expect(markup).not.toContain('<b>Hecho a mano</b>');
    expect(markup).not.toContain('<strong>Nuevo</strong>');
  });

  it('keeps legacy HTML in the sandboxed iframe and substitutes asset placeholders', () => {
    const markup = renderToStaticMarkup(
      <LandingPageRenderer
        content="<img src='LOGO_URL_PLACEHOLDER'><img src='LABEL_URL_PLACEHOLDER'>"
        logoUrl="https://example.com/logo.png"
        labelUrl="https://example.com/label.png"
        title="Landing Page Preview"
        className="w-full h-full border-0"
      />,
    );

    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).toContain('title="Landing Page Preview"');
    expect(markup).toContain('https://example.com/logo.png');
    expect(markup).toContain('https://example.com/label.png');
  });
});
