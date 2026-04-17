import fs from 'node:fs';

export function readChromeManifest(filePath = 'manifest.json') {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function createFirefoxManifest(chromeManifest) {
  const firefoxManifest = structuredClone(chromeManifest);
  firefoxManifest.background = {
    scripts: [chromeManifest.background.service_worker],
  };

  return firefoxManifest;
}