import { describe, expect, it } from 'vitest';

import {
  isLikelyCanvasSafeImageSource,
  stripPotentiallyTaintedImages,
} from '../src/content/export-utils.js';

describe('export image filtering', () => {
  const baseUrl = 'https://example.com/page';
  const pageOrigin = 'https://example.com';

  it('keeps embedded, blob, and same-origin image sources', () => {
    expect(isLikelyCanvasSafeImageSource('data:image/png;base64,AAAA', { baseUrl, pageOrigin }))
      .toBe(true);
    expect(isLikelyCanvasSafeImageSource('blob:https://example.com/123', { baseUrl, pageOrigin }))
      .toBe(true);
    expect(isLikelyCanvasSafeImageSource('/assets/logo.png', { baseUrl, pageOrigin }))
      .toBe(true);
    expect(isLikelyCanvasSafeImageSource('https://example.com/cdn/photo.jpg', { baseUrl, pageOrigin }))
      .toBe(true);
  });

  it('strips cross-origin image nodes but keeps non-image nodes', () => {
    const ir = [
      { type: 'image', dataUrl: 'https://cdn.example.net/photo.jpg' },
      { type: 'image', dataUrl: '/assets/logo.png' },
      { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
      { type: 'text', text: 'kept' },
    ];

    expect(stripPotentiallyTaintedImages(ir, { baseUrl, pageOrigin })).toEqual([
      { type: 'image', dataUrl: '/assets/logo.png' },
      { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
      { type: 'text', text: 'kept' },
    ]);
  });
});