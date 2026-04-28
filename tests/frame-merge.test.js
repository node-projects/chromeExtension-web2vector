import { describe, expect, it } from 'vitest';

import { mergeFrameExtractionResults } from '../src/shared/frame-merge.js';

describe('frame IR merging', () => {
  it('inserts child frame IR at the iframe paint-order anchor even when the iframe has no local IR nodes', () => {
    const merged = mergeFrameExtractionResults([
      {
        frameId: 0,
        result: {
          frameKey: 'root',
          paintOrder: [
            '/html/body/div',
            '/html/body/iframe',
            '/html/body/footer',
          ],
          childFrames: [
            {
              anchorXPath: '/html/body/iframe',
              childFrameKey: 'child',
              transform: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 20 },
              clipQuad: {
                points: [
                  { x: 50, y: 20 },
                  { x: 150, y: 20 },
                  { x: 150, y: 120 },
                  { x: 50, y: 120 },
                ],
                radius: 0,
              },
            },
          ],
          ir: [
            {
              type: 'polygon',
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
              ],
              style: {},
              zIndex: 1,
              source: { xpath: '/html/body/div', originalType: 'div' },
            },
            {
              type: 'polygon',
              points: [
                { x: 200, y: 0 },
                { x: 210, y: 0 },
                { x: 210, y: 10 },
                { x: 200, y: 10 },
              ],
              style: {},
              zIndex: 2,
              source: { xpath: '/html/body/footer', originalType: 'footer' },
            },
          ],
        },
      },
      {
        frameId: 5,
        result: {
          frameKey: 'child',
          paintOrder: ['/html/body/p'],
          childFrames: [],
          ir: [
            {
              type: 'text',
              quad: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 10 },
                { x: 0, y: 10 },
              ],
              text: 'inside iframe',
              style: {},
              zIndex: 1,
              source: { xpath: '/html/body/p', originalType: 'p' },
            },
          ],
        },
      },
    ], { rootFrameId: 0 });

    expect(merged?.ir.map((node) => node.source?.xpath)).toEqual([
      '/html/body/div',
      '/html/body/p',
      '/html/body/footer',
    ]);
    expect(merged?.ir[1].quad[0]).toEqual({ x: 50, y: 20 });
    expect(merged?.ir[1].style.clipQuads).toHaveLength(1);
  });

  it('transforms local frame clipping data into top-level coordinates', () => {
    const merged = mergeFrameExtractionResults([
      {
        frameId: 0,
        result: {
          frameKey: 'root',
          paintOrder: ['/html/body/iframe'],
          childFrames: [
            {
              anchorXPath: '/html/body/iframe',
              childFrameKey: 'child',
              transform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 5 },
              clipQuad: {
                points: [
                  { x: 10, y: 5 },
                  { x: 110, y: 5 },
                  { x: 110, y: 105 },
                  { x: 10, y: 105 },
                ],
                radius: 0,
              },
            },
          ],
          ir: [],
        },
      },
      {
        frameId: 7,
        result: {
          frameKey: 'child',
          paintOrder: ['/html/body/div'],
          childFrames: [],
          ir: [
            {
              type: 'polygon',
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
              ],
              style: {
                clipBounds: { x: 1, y: 2, w: 3, h: 4, radius: 0 },
                clipQuads: [
                  {
                    points: [
                      { x: 2, y: 3 },
                      { x: 6, y: 3 },
                      { x: 6, y: 7 },
                      { x: 2, y: 7 },
                    ],
                    radius: 0,
                  },
                ],
              },
              zIndex: 1,
              source: { xpath: '/html/body/div', originalType: 'div' },
            },
          ],
        },
      },
    ], { rootFrameId: 0 });

    expect(merged?.ir[0].style.clipBounds).toEqual({
      x: 11,
      y: 7,
      w: 3,
      h: 4,
      radius: 0,
    });
    expect(merged?.ir[0].style.clipQuads).toHaveLength(2);
    expect(merged?.ir[0].style.clipQuads[1].points[0]).toEqual({ x: 12, y: 8 });
  });
});