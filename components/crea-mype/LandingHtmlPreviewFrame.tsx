'use client';

import React from 'react';
import { buildLandingPreviewSrcDoc } from './landing-src-doc';

type LandingHtmlPreviewFrameProps = {
  html: string;
  logoUrl?: string | null;
  labelUrl?: string | null;
  title: string;
  className: string;
};

/** Renders legacy generated landing HTML inside a restricted iframe document. */
export function LandingHtmlPreviewFrame({ html, logoUrl, labelUrl, title, className }: LandingHtmlPreviewFrameProps) {
  return (
    <iframe
      srcDoc={buildLandingPreviewSrcDoc(html, logoUrl, labelUrl)}
      className={className}
      title={title}
      sandbox="allow-scripts"
    />
  );
}
