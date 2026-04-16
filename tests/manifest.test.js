import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('manifest.json', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));

  it('uses Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('declares required permissions', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['activeTab', 'downloads', 'scripting', 'contextMenus']),
    );
  });

  it('has a service worker', () => {
    expect(manifest.background.service_worker).toBe('service-worker.js');
  });

  it('has a popup', () => {
    expect(manifest.action.default_popup).toBe('popup.html');
  });

  it('declares icons at all required sizes', () => {
    for (const size of ['16', '32', '48', '128']) {
      expect(manifest.icons[size]).toMatch(/icon\d+\.png$/);
    }
  });
});
