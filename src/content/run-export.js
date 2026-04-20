/**
 * Run-export script — injected each time the user requests an export.
 *
 * Reads the requested format from globalThis.__web2vector_format,
 * performs the export via layout2vector, converts the result to a
 * data-URL, and sends it to the background service worker which
 * triggers chrome.downloads.download({ saveAs: true }).
 */
import { calculateExportSize } from './export-size.js';
import { extensionApi } from '../shared/extension-api.js';

(async () => {
  try {
    const format = globalThis.__web2vector_format;
    if (!format) throw new Error('No export format specified');

    const lib = globalThis.__web2vector;
    if (!lib) throw new Error('Core library not loaded');

    const { extractIR, renderIR, writers } = lib;

    const root = document.documentElement;

    const BITMAP_FORMATS = ['png', 'jpeg', 'webp'];
    const isBitmap = BITMAP_FORMATS.includes(format);

    // ── Extract IR ────────────────────────────────────────
    async function extract(includeImages) {
      return extractIR(root, {
        boxType: 'border',
        includeText: true,
        includeImages,
        walkIframes: true,
        convertFormControls: true,
      });
    }

    let ir = await extract(true);
    const { width, height } = calculateExportSize(root, ir);
    const maxY = height;

    // ── Render to chosen format ───────────────────────────
    let data;   // string | Uint8Array
    let mime;
    let ext;

    async function renderBitmap(irNodes, mimeType, quality) {
      const w = new writers.ImageWriter({ width, height, scale: 2 });
      const res = await renderIR(irNodes, w);
      await res.finalize();
      return res.toBytes(mimeType, quality);
    }

    switch (format) {
      /* ── Vector ── */
      case 'svg': {
        const w = new writers.SVGWriter({ width, height });
        data = await renderIR(ir, w);
        mime = 'image/svg+xml';
        ext = '.svg';
        break;
      }
      case 'dxf-standard': {
        const W = writers.DXFWriter;
        if (!W) throw new Error('DXF writer not loaded');
        const w = new W({ maxY });
        data = await renderIR(ir, w);
        mime = 'application/dxf';
        ext = '.dxf';
        break;
      }
      case 'dxf-acad': {
        const W = writers.AcadDXFWriter;
        if (!W) throw new Error('AcadDXF writer not loaded');
        const w = new W({ maxY });
        data = await renderIR(ir, w);
        mime = 'application/dxf';
        ext = '.dxf';
        break;
      }
      case 'dwg': {
        const W = writers.DWGWriter;
        if (!W) throw new Error('DWG writer not loaded');
        const w = new W({ maxY });
        data = await renderIR(ir, w);
        mime = 'application/acad';
        ext = '.dwg';
        break;
      }
      case 'emf': {
        const w = new writers.EMFWriter({ width, height });
        data = await renderIR(ir, w);
        mime = 'application/octet-stream';
        ext = '.emf';
        break;
      }
      case 'emfplus': {
        const w = new writers.EMFPlusWriter({ width, height });
        data = await renderIR(ir, w);
        mime = 'application/octet-stream';
        ext = '.emf';
        break;
      }

      /* ── Document ── */
      case 'pdf': {
        const w = new writers.PDFWriter();
        const doc = await renderIR(ir, w);
        await doc.finalize();
        data = doc.toBytes();
        mime = 'application/pdf';
        ext = '.pdf';
        break;
      }
      case 'html': {
        const w = new writers.HTMLWriter({ width, height });
        data = await renderIR(ir, w);
        mime = 'text/html';
        ext = '.html';
        break;
      }

      /* ── Image (bitmap) ── */
      case 'png': {
        mime = 'image/png';
        ext = '.png';
        try {
          data = await renderBitmap(ir, mime);
        } catch (e) {
          if (isTaintedCanvasError(e)) {
            ir = await extract(false);
            data = await renderBitmap(ir, mime);
          } else throw e;
        }
        break;
      }
      case 'jpeg': {
        mime = 'image/jpeg';
        ext = '.jpg';
        try {
          data = await renderBitmap(ir, mime, 0.92);
        } catch (e) {
          if (isTaintedCanvasError(e)) {
            ir = await extract(false);
            data = await renderBitmap(ir, mime, 0.92);
          } else throw e;
        }
        break;
      }
      case 'webp': {
        mime = 'image/webp';
        ext = '.webp';
        try {
          data = await renderBitmap(ir, mime, 0.90);
        } catch (e) {
          if (isTaintedCanvasError(e)) {
            ir = await extract(false);
            data = await renderBitmap(ir, mime, 0.90);
          } else throw e;
        }
        break;
      }

      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    // ── Convert to data-URL ───────────────────────────────
    const blob = new Blob(
      [data instanceof Uint8Array ? data : new TextEncoder().encode(data)],
      { type: mime },
    );
    const dataUrl = await blobToDataUrl(blob);

    // ── Build filename ────────────────────────────────────
    const title = (document.title || 'export')
      .replace(/[<>:"/\\|?*]+/g, '_')
      .substring(0, 80);
    const filename = `${title}${ext}`;

    // ── Send to background → chrome.downloads ─────────────
    extensionApi.runtime.sendMessage({
      type: 'export-result',
      dataUrl,
      filename,
    });
  } catch (err) {
    extensionApi.runtime.sendMessage({
      type: 'export-error',
      error: String(err?.message ?? err),
    });
  }
})();

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function isTaintedCanvasError(err) {
  return err instanceof DOMException &&
    (err.name === 'SecurityError' || err.message.includes('Tainted'));
}
