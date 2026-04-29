import { describe, expect, it } from 'vitest';

import {
  normalizeTransferredFontAssets,
  serializeFontAssetsForTransfer,
} from '../src/shared/font-assets.js';

describe('normalizeTransferredFontAssets', () => {
  it('preserves existing Uint8Array sources', () => {
    const fontAssets = normalizeTransferredFontAssets({
      faces: [{
        family: 'Font Awesome 6 Free',
        weight: '900',
        sources: [{
          format: 'ttf',
          mimeType: 'font/ttf',
          data: new Uint8Array([1, 2, 3]),
        }],
      }],
    });

    expect(fontAssets?.faces).toHaveLength(1);
    expect(fontAssets?.faces[0].sources[0].data).toBeInstanceOf(Uint8Array);
    expect(Array.from(fontAssets?.faces[0].sources[0].data ?? [])).toEqual([1, 2, 3]);
  });

  it('rebuilds JSON-serialized typed arrays from numeric-key objects', () => {
    const fontAssets = normalizeTransferredFontAssets({
      faces: [{
        family: 'Font Awesome 6 Brands',
        weight: '400',
        sources: [{
          format: 'ttf',
          mimeType: 'font/ttf',
          data: { 0: 9, 1: 10, 2: 255 },
        }],
      }],
    });

    expect(fontAssets?.faces).toHaveLength(1);
    expect(fontAssets?.faces[0].sources[0].data).toBeInstanceOf(Uint8Array);
    expect(Array.from(fontAssets?.faces[0].sources[0].data ?? [])).toEqual([9, 10, 255]);
  });

  it('drops sources with unusable byte payloads', () => {
    const fontAssets = normalizeTransferredFontAssets({
      faces: [{
        family: 'Broken Font',
        sources: [{
          format: 'ttf',
          mimeType: 'font/ttf',
          data: null,
        }],
      }],
    });

    expect(fontAssets).toBeUndefined();
  });

  it('serializes Uint8Array sources into executeScript-safe arrays', () => {
    const fontAssets = serializeFontAssetsForTransfer({
      faces: [{
        family: 'Font Awesome 6 Free',
        weight: '900',
        sources: [{
          format: 'ttf',
          mimeType: 'font/ttf',
          data: new Uint8Array([1, 2, 3]),
        }],
      }],
    });

    expect(fontAssets?.faces).toHaveLength(1);
    expect(Array.isArray(fontAssets?.faces[0].sources[0].data)).toBe(true);
    expect(fontAssets?.faces[0].sources[0].data).toEqual([1, 2, 3]);
  });

  it('round-trips transfer serialization back to Uint8Array', () => {
    const transferred = serializeFontAssetsForTransfer({
      faces: [{
        family: 'Font Awesome 6 Brands',
        weight: '400',
        sources: [{
          format: 'ttf',
          mimeType: 'font/ttf',
          data: new Uint8Array([9, 10, 11]),
        }],
      }],
    });
    const normalized = normalizeTransferredFontAssets(transferred);

    expect(normalized?.faces).toHaveLength(1);
    expect(normalized?.faces[0].sources[0].data).toBeInstanceOf(Uint8Array);
    expect(Array.from(normalized?.faces[0].sources[0].data ?? [])).toEqual([9, 10, 11]);
  });
});