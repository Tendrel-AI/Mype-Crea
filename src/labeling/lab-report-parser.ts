import type { ParseIssue, ParsedLabReport } from './types';
import { extractPdfText } from './pdf-text';
import { parseLabReportText } from './parse-lab-report-text';

const emptyReport = (fileId: string, issue: ParseIssue): ParsedLabReport => ({
  fileId,
  reportNumber: null,
  laboratory: null,
  issuedAt: null,
  sample: { description: null, lot: null, declaredContent: null, state: null, densityGPerMl: null },
  kind: 'unknown',
  measurements: [],
  otherParameters: [],
  issues: [issue],
});

/** Lab report PDF -> ParsedLabReport. Deterministic, never throws. */
export async function parseLabReportPdf(bytes: Uint8Array, fileId: string): Promise<ParsedLabReport> {
  let pages;
  try {
    pages = await extractPdfText(bytes);
  } catch (e) {
    const encrypted = e instanceof Error && e.name === 'PasswordException';
    return emptyReport(
      fileId,
      encrypted
        ? { code: 'encrypted_pdf', message: 'Este PDF está protegido con contraseña. Sube el informe sin protección.' }
        : { code: 'unreadable_pdf', message: 'No pudimos leer este archivo. Verifica que sea un PDF válido y vuelve a subirlo.' },
    );
  }
  if (pages.every((p) => p.length === 0)) {
    return emptyReport(fileId, {
      code: 'no_text_layer',
      message: 'Este PDF parece escaneado y no tiene texto seleccionable. Sube el informe digital que te envió el laboratorio.',
    });
  }
  return parseLabReportText(pages, fileId);
}
