/** Client side of `POST /api/brand-files`: uploads one file and returns a Spanish error or null. */
export async function uploadBrandFile(input: {
  brandId: string;
  productId?: string;
  kind: 'logo' | 'asset' | 'lab_report';
  file: File;
}): Promise<string | null> {
  const body = new FormData();
  body.set('brandId', input.brandId);
  if (input.productId) body.set('productId', input.productId);
  body.set('kind', input.kind);
  body.set('file', input.file);
  try {
    const response = await fetch('/api/brand-files', { method: 'POST', body });
    if (response.ok) return null;
    const detail = (await response.json().catch(() => null)) as { message?: string } | null;
    return `«${input.file.name}»: ${detail?.message ?? 'no pudimos subirlo.'}`;
  } catch {
    return `«${input.file.name}»: no pudimos subirlo. Revisa tu conexión.`;
  }
}

/** Upload the chosen logo and assets one by one. Failures are collected, never thrown; `remaining` is what still needs uploading. */
export async function uploadBrandFiles(
  brandId: string,
  files: { readonly logo: File | null; readonly assets: ReadonlyArray<File> },
): Promise<{ errors: string[]; remaining: { logo: File | null; assets: File[] } }> {
  const errors: string[] = [];
  const remaining: { logo: File | null; assets: File[] } = { logo: null, assets: [] };
  if (files.logo) {
    const error = await uploadBrandFile({ brandId, kind: 'logo', file: files.logo });
    if (error) { errors.push(error); remaining.logo = files.logo; }
  }
  for (const file of files.assets) {
    const error = await uploadBrandFile({ brandId, kind: 'asset', file });
    if (error) { errors.push(error); remaining.assets.push(file); }
  }
  return { errors, remaining };
}

/** D32: upload lab-report PDFs one by one; `uploaded` counts the stored ones, `errors` are Spanish and never thrown. */
export async function uploadLabReports(
  brandId: string,
  productId: string,
  files: ReadonlyArray<File>,
): Promise<{ uploaded: number; errors: string[] }> {
  const errors: string[] = [];
  let uploaded = 0;
  for (const file of files) {
    const error = await uploadBrandFile({ brandId, productId, kind: 'lab_report', file });
    if (error) errors.push(error);
    else uploaded += 1;
  }
  return { uploaded, errors };
}
