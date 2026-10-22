'use client';

import React from 'react';

type LandingHtmlPreviewFrameProps = {
  html: string;
  logoUrl?: string | null;
  labelUrl?: string | null;
  title: string;
  className: string;
};

/** Renders legacy generated landing HTML inside a restricted iframe document. */
export function LandingHtmlPreviewFrame({ html, logoUrl, labelUrl, title, className }: LandingHtmlPreviewFrameProps) {
  const landingHtml = html
    .replace(/LOGO_URL_PLACEHOLDER/g, logoUrl || '')
    .replace(/LABEL_URL_PLACEHOLDER/g, labelUrl || '');

  const srcDoc = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
        <script>
          tailwind.config = {
            theme: {
              extend: {
                fontFamily: {
                  sans: ['Inter', 'sans-serif'],
                  display: ['Space Grotesk', 'sans-serif'],
                }
              }
            }
          }
        </script>
        <style>
          body { font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }
          h1, h2, h3, h4, h5, h6 { font-family: 'Space Grotesk', sans-serif; letter-spacing: -0.02em; }
        </style>
      </head>
      <body class="bg-neutral-50 text-neutral-900">
        ${landingHtml}
      </body>
    </html>
  `;

  return (
    <iframe
      srcDoc={srcDoc}
      className={className}
      title={title}
      sandbox="allow-scripts"
    />
  );
}
