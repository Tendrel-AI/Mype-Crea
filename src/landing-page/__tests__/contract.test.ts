import { describe, expect, it } from 'vitest';
import { parseLandingPageContent } from '../contract';

describe('landing page content contract', () => {
  it('keeps legacy HTML explicitly discriminated, including older bare and html-field records', () => {
    for (const input of ['<h1>Legacy</h1>', { html: '<h1>Legacy</h1>' }, { format: 'legacy-html', html: '<b>x</b>' }]) {
      const result = parseLandingPageContent(input);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.format).toBe('legacy-html');
    }
  });

  it('rejects unsupported versions and does not infer typed content from HTML', () => {
    expect(parseLandingPageContent({ format: 'typed', schemaVersion: 2, sections: [] })).toEqual({
      success: false,
      reason: 'unsupported-version',
    });
    expect(parseLandingPageContent({ sections: [{ kind: 'hero', heading: 'x' }] })).toEqual({ success: false, reason: 'invalid' });
  });

  it('preserves supported section order, drops unknown and invalid sections, and keeps text literal', () => {
    const result = parseLandingPageContent({
      format: 'typed',
      schemaVersion: 1,
      sections: [
        { kind: 'contact', heading: '<script>text</script>', methods: [{ label: 'Web', url: 'https://example.com' }] },
        { kind: 'future-kind', arbitrary: true },
        { kind: 'callToAction', heading: 'Invalid', supportingText: 'x', label: 'Go', url: 'javascript:alert(1)' },
        { kind: 'hero', heading: 'Hello', supportingText: '<em>plain text</em>', imageUrl: 'data:text/html,x' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.format === 'typed') {
      expect(result.data.sections.map((section) => section.kind)).toEqual(['contact', 'hero']);
      expect(result.data.sections[0]).toMatchObject({ heading: '<script>text</script>' });
      expect(result.data.sections[1]).not.toHaveProperty('imageUrl');
    }
  });

  it('omits invalid optional links but rejects sections with invalid required URLs', () => {
    const result = parseLandingPageContent({
      format: 'typed',
      schemaVersion: 1,
      sections: [
        { kind: 'hero', heading: 'A', supportingText: 'B', callToAction: { label: 'Go', url: '//evil.example' } },
        { kind: 'contact', heading: 'Contact', methods: [{ label: 'Email', url: 'mailto:a@example.com' }] },
        { kind: 'gallery', heading: 'Photos', images: [{ imageUrl: '/relative.jpg', alt: 'Photo' }] },
        { kind: 'callToAction', heading: 'Malformed', supportingText: 'x', label: 'Go', url: 'https:shop.example' },
        { kind: 'callToAction', heading: 'Buy', supportingText: 'Now', label: 'Shop', url: 'https://shop.example/path' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.format === 'typed') {
      expect(result.data.sections.map((section) => section.kind)).toEqual(['hero', 'contact', 'callToAction']);
      expect(result.data.sections[0]).not.toHaveProperty('callToAction');
      expect(result.data.sections[1]).toMatchObject({ methods: [{ label: 'Email' }] });
      expect(result.data.sections[2]).toMatchObject({ url: 'https://shop.example/path' });
    }
  });
});
