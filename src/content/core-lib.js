/**
 * Core library bundle – injected once per tab.
 *
 * Includes: getBoxQuads polyfill, extractIR, renderIR,
 * and all writers that have NO external npm dependencies
 * (SVGWriter, HTMLWriter, PDFWriter, EMFWriter, ImageWriter).
 */
import { addPolyfill } from 'get-box-quads-polyfill';
import {
  extractIR,
  renderIR,
  SVGWriter,
  HTMLWriter,
  PDFWriter,
  EMFWriter,
  EMFPlusWriter,
  ImageWriter,
} from '@node-projects/layout2vector';

if (!globalThis.__web2vector) {
  try { addPolyfill(window, true); } catch (_) { /* already applied or native */ }

  globalThis.__web2vector = {
    extractIR,
    renderIR,
    writers: { SVGWriter, HTMLWriter, PDFWriter, EMFWriter, EMFPlusWriter, ImageWriter },
  };
}
