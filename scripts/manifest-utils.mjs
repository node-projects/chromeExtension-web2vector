import fs from 'node:fs';

export const DEFAULT_FIREFOX_ADDON_ID = 'web2vector@node-projects.github.io';
export const DEFAULT_FIREFOX_DATA_COLLECTION_PERMISSIONS = {
  required: ['websiteContent'],
};

export function readChromeManifest(filePath = 'manifest.json') {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function createFirefoxManifest(chromeManifest) {
  const firefoxManifest = structuredClone(chromeManifest);
  const geckoSettings = firefoxManifest.browser_specific_settings?.gecko ?? {};

  firefoxManifest.background = {
    scripts: [chromeManifest.background.service_worker],
  };
  firefoxManifest.browser_specific_settings = {
    ...firefoxManifest.browser_specific_settings,
    gecko: {
      ...geckoSettings,
      id: geckoSettings.id ?? DEFAULT_FIREFOX_ADDON_ID,
      data_collection_permissions: geckoSettings.data_collection_permissions
        ?? structuredClone(DEFAULT_FIREFOX_DATA_COLLECTION_PERMISSIONS),
    },
  };

  return firefoxManifest;
}