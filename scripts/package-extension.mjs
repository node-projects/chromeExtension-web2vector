/**
 * Package the built extension into a ZIP for Chrome Web Store upload.
 * Produces  web2vector-<version>.zip  in the project root.
 */
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const zipName = `web2vector-${pkg.version}.zip`;
const output = fs.createWriteStream(zipName);

const archive = archiver('zip', { zlib: { level: 9 } });

archive.on('error', (err) => { throw err; });
archive.on('end', () => {
  const bytes = archive.pointer();
  console.log(`\n✔ ${zipName}  (${(bytes / 1024).toFixed(1)} KB)`);
});

archive.pipe(output);
archive.directory('dist/', false);
await archive.finalize();
