import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await mkdir(`${root}dist/pdfjs/${directory}`, { recursive: true });
  await cp(`${root}node_modules/pdfjs-dist/${directory}`, `${root}dist/pdfjs/${directory}`, {
    recursive: true,
  });
}
await cp(`${root}node_modules/pdfjs-dist/LICENSE`, `${root}dist/pdfjs/LICENSE`);
