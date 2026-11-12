import { getDocumentProxy } from 'unpdf';

export interface TextItem {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}
export type PdfPage = ReadonlyArray<TextItem>;

/** Thin unpdf wrapper: positioned text items per page. Throws on corrupted/encrypted input. */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfPage[]> {
  // pdf.js transfers the buffer; hand it a copy so callers keep theirs.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: PdfPage[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const items: TextItem[] = [];
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      items.push({ text: it.str, x: it.transform[4], y: it.transform[5] });
    }
    pages.push(items);
  }
  return pages;
}
