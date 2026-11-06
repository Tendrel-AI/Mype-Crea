/** Versioned, presentation-safe landing-page content. Text is always rendered as text. */
export const LANDING_PAGE_SCHEMA_VERSION = 1 as const;

export type HeroSection = {
  kind: 'hero';
  heading: string;
  supportingText: string;
  imageUrl?: string;
  callToAction?: { label: string; url: string };
};
export type BenefitsSection = {
  kind: 'benefits';
  heading: string;
  benefits: Array<{ heading: string; body: string }>;
};
export type GallerySection = {
  kind: 'gallery';
  heading: string;
  images: Array<{ imageUrl: string; alt: string; caption?: string }>;
};
export type CallToActionSection = {
  kind: 'callToAction';
  heading: string;
  supportingText: string;
  label: string;
  url: string;
};
export type ContactSection = {
  kind: 'contact';
  heading: string;
  methods: Array<{ label: string; value?: string; url?: string }>;
};

export type LandingPageSection =
  | HeroSection
  | BenefitsSection
  | GallerySection
  | CallToActionSection
  | ContactSection;

export type TypedLandingPageContent = {
  format: 'typed';
  schemaVersion: typeof LANDING_PAGE_SCHEMA_VERSION;
  sections: LandingPageSection[];
};
export type LegacyLandingPageContent = { format: 'legacy-html'; html: string };
export type LandingPageContent = TypedLandingPageContent | LegacyLandingPageContent;

export type LandingPageParseResult =
  | { success: true; data: LandingPageContent }
  | { success: false; reason: 'invalid' | 'unsupported-version' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Only absolute web URLs are accepted; no relative, protocol-relative, or active-content schemes. */
export function normalizeWebUrl(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    !/^https?:\/\//i.test(value)
  ) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizeSection(value: unknown): LandingPageSection | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
  switch (value.kind) {
    case 'hero': {
      if (!requiredText(value.heading) || !requiredText(value.supportingText)) return undefined;
      const section: HeroSection = { kind: 'hero', heading: value.heading, supportingText: value.supportingText };
      const imageUrl = normalizeWebUrl(value.imageUrl);
      if (imageUrl) section.imageUrl = imageUrl;
      if (isRecord(value.callToAction)) {
        const url = normalizeWebUrl(value.callToAction.url);
        if (requiredText(value.callToAction.label) && url) section.callToAction = { label: value.callToAction.label, url };
      }
      return section;
    }
    case 'benefits': {
      if (!requiredText(value.heading) || !Array.isArray(value.benefits)) return undefined;
      const benefits = value.benefits.flatMap((item) =>
        isRecord(item) && requiredText(item.heading) && requiredText(item.body)
          ? [{ heading: item.heading, body: item.body }]
          : [],
      );
      return benefits.length ? { kind: 'benefits', heading: value.heading, benefits } : undefined;
    }
    case 'gallery': {
      if (!requiredText(value.heading) || !Array.isArray(value.images)) return undefined;
      const images = value.images.flatMap((item) => {
        if (!isRecord(item) || !requiredText(item.alt)) return [];
        const imageUrl = normalizeWebUrl(item.imageUrl);
        if (!imageUrl) return [];
        const image: GallerySection['images'][number] = { imageUrl, alt: item.alt };
        if (requiredText(item.caption)) image.caption = item.caption;
        return [image];
      });
      return images.length ? { kind: 'gallery', heading: value.heading, images } : undefined;
    }
    case 'callToAction': {
      const url = normalizeWebUrl(value.url);
      if (!requiredText(value.heading) || !requiredText(value.supportingText) || !requiredText(value.label) || !url) return undefined;
      return { kind: 'callToAction', heading: value.heading, supportingText: value.supportingText, label: value.label, url };
    }
    case 'contact': {
      if (!requiredText(value.heading) || !Array.isArray(value.methods)) return undefined;
      const methods = value.methods.flatMap((item) => {
        if (!isRecord(item) || !requiredText(item.label)) return [];
        const method: ContactSection['methods'][number] = { label: item.label };
        if (requiredText(item.value)) method.value = item.value;
        if (item.url !== undefined) {
          const url = normalizeWebUrl(item.url);
          if (url) method.url = url;
        }
        return [method];
      });
      return methods.length ? { kind: 'contact', heading: value.heading, methods } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Safely normalizes legacy HTML or the v1 typed envelope. Unknown section kinds and invalid
 * sections are dropped; an unknown schema version is rejected without interpreting its payload.
 */
export function parseLandingPageContent(value: unknown): LandingPageParseResult {
  if (typeof value === 'string') return { success: true, data: { format: 'legacy-html', html: value } };
  if (!isRecord(value)) return { success: false, reason: 'invalid' };

  if (value.format === 'legacy-html') {
    return typeof value.html === 'string'
      ? { success: true, data: { format: 'legacy-html', html: value.html } }
      : { success: false, reason: 'invalid' };
  }
  // Historical records stored the HTML directly in an `html` field without a discriminator.
  if (value.format === undefined && typeof value.html === 'string') {
    return { success: true, data: { format: 'legacy-html', html: value.html } };
  }
  if (value.format !== 'typed' || !Number.isInteger(value.schemaVersion)) return { success: false, reason: 'invalid' };
  if (value.schemaVersion !== LANDING_PAGE_SCHEMA_VERSION) return { success: false, reason: 'unsupported-version' };
  if (!Array.isArray(value.sections)) return { success: false, reason: 'invalid' };

  return {
    success: true,
    data: {
      format: 'typed',
      schemaVersion: LANDING_PAGE_SCHEMA_VERSION,
      sections: value.sections.flatMap((section) => normalizeSection(section) ?? []),
    },
  };
}
