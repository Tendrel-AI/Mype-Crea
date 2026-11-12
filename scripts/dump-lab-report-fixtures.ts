/** `jiti scripts/dump-lab-report-fixtures.ts <pdf-dir>`: dumps redacted extractPdfText output as test fixtures. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPdfText } from '../src/labeling/pdf-text';

const dir = process.argv[2];
if (!dir) throw new Error('usage: dump-lab-report-fixtures.ts <pdf-dir>');
const out = join(process.cwd(), 'src/labeling/__tests__/fixtures');
const REDACT: Array<[string, string]> = [['cliente', 'CLIENTE'], ['direccion', 'DIRECCION'], ['telefono', 'TELEFONO']];
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[:\s]+$/, '');

async function main() {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.pdf'))) {
    const pages = await extractPdfText(readFileSync(join(dir, f)));
    const redacted = pages.map((items) => {
      const copy = items.map((i) => ({ ...i }));
      for (const [label, repl] of REDACT) {
        const l = items.find((i) => norm(i.text) === label);
        if (!l) continue;
        const v = copy.find((i) => Math.abs(i.y - l.y) <= 2 && i.x > l.x);
        if (v) v.text = repl;
      }
      return copy;
    });
    writeFileSync(join(out, f.replace(/_signed\.pdf$|\.pdf$/, '') + '.json'), JSON.stringify(redacted, null, 1));
  }
}
void main();
