/**
 * Builds the iframe `srcDoc` for legacy generated landing HTML. Single source for the
 * dashboard card and the full-screen tab (previously duplicated inline in CreaMype.tsx).
 * Only leading indentation differs from the pre-migration template; see
 * docs/ui/react-migration-baseline.md, "Migration deviations".
 */
export function buildLandingPreviewSrcDoc(html: string, logoUrl?: string | null, labelUrl?: string | null): string {
  const landingHtml = html
    .replace(/LOGO_URL_PLACEHOLDER/g, logoUrl || '')
    .replace(/LABEL_URL_PLACEHOLDER/g, labelUrl || '');

  return `
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
}
