/**
 * Convert the source SVG icon to PNGs at sizes required by Chrome extensions.
 * Uses @resvg/resvg-js — run with:  npm run build:icons
 */
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';

const SIZES = [16, 32, 48, 128];
const SVG_PATH = path.join('src', 'icons', 'icon.svg');
const OUT_DIR = path.join('src', 'icons');

fs.mkdirSync(OUT_DIR, { recursive: true });

const svgString = fs.readFileSync(SVG_PATH, 'utf8');

for (const size of SIZES) {
  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'width', value: size },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  const outPath = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, pngBuffer);
  console.log(`  ✔ ${outPath}`);
}

console.log('\nIcons generated.');
