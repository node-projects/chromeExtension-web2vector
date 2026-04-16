/**
 * Lazy-loaded DXF writer chunk.
 * Pulls in @tarikjabiri/dxf at bundle time.
 * Only injected when the user picks "DXF (Standard)".
 */
import { DXFWriter } from '@node-projects/layout2vector';

if (globalThis.__web2vector) {
  globalThis.__web2vector.writers.DXFWriter = DXFWriter;
}
