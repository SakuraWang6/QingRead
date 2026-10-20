import { cp, mkdir } from 'node:fs/promises';
for (const name of ['cmaps','standard_fonts','wasm']) {
  await mkdir(`public/pdfjs/${name}`, {recursive:true});
  await cp(`node_modules/pdfjs-dist/${name}`, `public/pdfjs/${name}`, {recursive:true});
}
