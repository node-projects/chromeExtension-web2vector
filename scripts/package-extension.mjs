/**
 * Package the built extension into a ZIP for browser store upload.
 */
import archiver from 'archiver';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const browser = process.argv[2] ?? 'chrome';
const targets = {
  chrome: {
    sourceDir: 'dist',
    zipName: `web2vector-chrome-${pkg.version}.zip`,
  },
  firefox: {
    sourceDir: 'dist-firefox',
    zipName: `web2vector-firefox-${pkg.version}.zip`,
  },
};

const target = targets[browser];

if (!target) {
  throw new Error(`Unknown package target: ${browser}`);
}

if (!fs.existsSync(target.sourceDir)) {
  throw new Error(`Build output not found: ${target.sourceDir}`);
}

const zipName = target.zipName;
const output = fs.createWriteStream(zipName);

const archive = archiver('zip', { zlib: { level: 9 } });

archive.on('error', (err) => { throw err; });
archive.on('end', () => {
  const bytes = archive.pointer();
  console.log(`\n✔ ${zipName}  (${(bytes / 1024).toFixed(1)} KB)`);
});

archive.pipe(output);
archive.directory(`${target.sourceDir}/`, false);
await archive.finalize();
