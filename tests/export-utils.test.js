import { describe, expect, it, vi } from 'vitest';

import {
  classifyCanvasImageSource,
  collectInaccessibleIframeDiagnostics,
  collectPotentiallyTaintedImageDiagnostics,
  isLikelyCanvasSafeImageSource,
  replaceUnsafeImageSources,
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

  it('classifies image sources by canvas safety', () => {
    expect(classifyCanvasImageSource('/assets/logo.png', { baseUrl, pageOrigin }))
      .toEqual(expect.objectContaining({
        classification: 'same-origin-url',
        resolvedUrl: 'https://example.com/assets/logo.png',
        origin: 'https://example.com',
      }));

    expect(classifyCanvasImageSource('https://cdn.example.net/photo.jpg', { baseUrl, pageOrigin }))
      .toEqual(expect.objectContaining({
        classification: 'cross-origin-url',
        resolvedUrl: 'https://cdn.example.net/photo.jpg',
        origin: 'https://cdn.example.net',
      }));

    expect(classifyCanvasImageSource('file:///tmp/image.png', { baseUrl, pageOrigin }))
      .toEqual(expect.objectContaining({
        classification: 'file-url',
        resolvedUrl: 'file:///tmp/image.png',
      }));

    expect(classifyCanvasImageSource('', { baseUrl, pageOrigin }))
      .toEqual(expect.objectContaining({
        classification: 'missing-source',
        resolvedUrl: null,
      }));
  });

  it('collects diagnostics for unsafe image nodes', () => {
    const diagnostics = collectPotentiallyTaintedImageDiagnostics([
      {
        type: 'image',
        dataUrl: 'https://cdn.example.net/photo.jpg',
        source: {
          xpath: '/html/body/img[1]',
          originalType: 'img',
        },
      },
      { type: 'image', dataUrl: '/assets/logo.png' },
      { type: 'text', text: 'kept' },
    ], { baseUrl, pageOrigin });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        classification: 'cross-origin-url',
        resolvedUrl: 'https://cdn.example.net/photo.jpg',
        originalType: 'img',
        xpath: '/html/body/img[1]',
      }),
    ]);
  });

  it('replaces unsafe image URLs with resolved image data URLs', async () => {
    const resolver = vi.fn(async (source) => {
      if (source === 'https://cdn.example.net/photo.jpg') {
        return 'data:image/jpeg;base64,AAAA';
      }

      return null;
    });

    const result = await replaceUnsafeImageSources([
      { type: 'image', dataUrl: 'https://cdn.example.net/photo.jpg' },
      { type: 'image', dataUrl: '/assets/logo.png' },
      { type: 'image', dataUrl: 'https://cdn.example.net/photo.jpg' },
    ], resolver, { baseUrl, pageOrigin });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { type: 'image', dataUrl: 'data:image/jpeg;base64,AAAA' },
      { type: 'image', dataUrl: '/assets/logo.png' },
      { type: 'image', dataUrl: 'data:image/jpeg;base64,AAAA' },
    ]);
  });

  it('reports inaccessible iframe diagnostics', () => {
    const accessibleFrameDoc = {
      querySelectorAll: () => [],
    };
    const sameOriginIframe = {
      tagName: 'IFRAME',
      src: 'https://example.com/frame',
      title: 'same-origin',
      contentDocument: accessibleFrameDoc,
    };
    const unloadedIframe = {
      tagName: 'IFRAME',
      src: 'https://example.com/pending',
      title: 'pending',
      contentDocument: null,
    };
    const crossOriginIframe = {
      tagName: 'IFRAME',
      src: 'https://cdn.example.net/embed',
      title: 'cross-origin',
    };

    Object.defineProperty(crossOriginIframe, 'contentDocument', {
      get() {
        const error = new Error('Permission denied');
        error.name = 'SecurityError';
        throw error;
      },
    });

    const root = {
      querySelectorAll: () => [sameOriginIframe, unloadedIframe, crossOriginIframe],
    };

    expect(collectInaccessibleIframeDiagnostics(root)).toEqual([
      {
        src: 'https://example.com/pending',
        title: 'pending',
        reason: 'iframe-not-loaded',
        errorName: null,
      },
      {
        src: 'https://cdn.example.net/embed',
        title: 'cross-origin',
        reason: 'cross-origin-iframe',
        errorName: 'SecurityError',
      },
    ]);
  });
});