/**
 * Upload the packaged ZIP to the Chrome Web Store.
 *
 * Required environment variables:
 *   CHROME_EXTENSION_ID   – your extension ID (from the Chrome Web Store dashboard)
 *   CHROME_CLIENT_ID      – OAuth2 client ID
 *   CHROME_CLIENT_SECRET  – OAuth2 client secret
 *   CHROME_REFRESH_TOKEN  – OAuth2 refresh token
 *
 * Usage:
 *   npm run package          # build + zip
 *   npm run upload           # upload to Chrome Web Store
 */
import chromeWebstoreUpload from 'chrome-webstore-upload';
import fs from 'node:fs';

const requiredEnv = [
  'CHROME_EXTENSION_ID',
  'CHROME_CLIENT_ID',
  'CHROME_CLIENT_SECRET',
  'CHROME_REFRESH_TOKEN',
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const store = chromeWebstoreUpload({
  extensionId: process.env.CHROME_EXTENSION_ID,
  clientId: process.env.CHROME_CLIENT_ID,
  clientSecret: process.env.CHROME_CLIENT_SECRET,
  refreshToken: process.env.CHROME_REFRESH_TOKEN,
});

// Find the zip file
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const zipName = `web2vector-${pkg.version}.zip`;

if (!fs.existsSync(zipName)) {
  console.error(`ZIP not found: ${zipName}\nRun "npm run package" first.`);
  process.exit(1);
}

console.log(`Uploading ${zipName}…`);
const zipStream = fs.createReadStream(zipName);

const uploadResult = await store.uploadExisting(zipStream);
console.log('Upload result:', uploadResult);

if (uploadResult.uploadState === 'FAILURE') {
  console.error('Upload failed:', uploadResult.itemError);
  process.exit(1);
}

console.log('Publishing…');
const publishResult = await store.publish();
console.log('Publish result:', publishResult);

console.log('\n✔ Extension published to Chrome Web Store');
