import { describe, expect, it } from 'vitest';
import {
  applyIrExtentFallback,
  getViewportSizeFromMetrics,
} from '../src/content/export-size.js';

describe('getViewportSizeFromMetrics', () => {
  it('uses quad bounds when they exceed the root metrics', () => {
    const viewport = getViewportSizeFromMetrics({
      quads: [{
        p1: { x: -20, y: 10 },
        p2: { x: 100, y: 10 },
        p3: { x: 100, y: 140 },
        p4: { x: -20, y: 140 },
      }],
      rect: { width: 80, height: 90 },
      scrollWidth: 60,
      scrollHeight: 70,
      clientWidth: 50,
      clientHeight: 40,
    });

    expect(viewport).toEqual({ width: 120, height: 130 });
  });

  it('falls back to rect and scrolling metrics when no quads are available', () => {
    const viewport = getViewportSizeFromMetrics({
      quads: [],
      rect: { width: 220, height: 120 },
      scrollWidth: 320,
      scrollHeight: 240,
      clientWidth: 160,
      clientHeight: 180,
    });

    expect(viewport).toEqual({ width: 320, height: 240 });
  });
});

describe('applyIrExtentFallback', () => {
  it('uses IR bounds when the root viewport is unexpectedly empty', () => {
    const viewport = applyIrExtentFallback(
      { width: 1, height: 1 },
      [
        {
          type: 'polygon',
          points: [
            { x: 0, y: 0 },
            { x: 150.2, y: 0 },
            { x: 150.2, y: 90.1 },
          ],
        },
        {
          type: 'text',
          quad: [
            { x: 0, y: 0 },
            { x: 25, y: 0 },
            { x: 200.8, y: 101.3 },
            { x: 5, y: 101.3 },
          ],
        },
      ],
    );

    expect(viewport).toEqual({ width: 201, height: 102 });
  });
});