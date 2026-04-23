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
import { EXPORT_STREAM_CHUNK_BYTES, createExportTransferId } from '../shared/export-transfer.js';
import {
  collectInaccessibleIframeDiagnostics,
  collectPotentiallyTaintedImageDiagnostics,
  createExportBlob,
  replaceUnsafeImageSources,
  stripPotentiallyTaintedImages,
} from './export-utils.js';

const PX_TO_MM = 25.4 / 96;

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
        includeSourceMetadata: true,
        walkIframes: true,
        convertFormControls: true,
      });
    }

    let ir = await extract(true);
    ir = await resolveUnsafeImageSourcesViaExtension(ir);
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

    async function renderBitmapWithFallback(mimeType, quality) {
      try {
        return await renderBitmap(ir, mimeType, quality);
      } catch (error) {
        if (!isTaintedCanvasError(error)) throw error;

        const filteredIr = stripPotentiallyTaintedImages(ir);
        logBitmapFallbackDiagnostics({
          format,
          imageNodeCount: countImageNodes(ir),
          filteredImageNodeCount: countImageNodes(filteredIr),
          taintedImages: collectPotentiallyTaintedImageDiagnostics(ir),
          inaccessibleIframes: collectInaccessibleIframeDiagnostics(root),
        });

        if (filteredIr.length !== ir.length) {
          try {
            ir = filteredIr;
            return await renderBitmap(ir, mimeType, quality);
          } catch (retryError) {
            if (!isTaintedCanvasError(retryError)) throw retryError;
          }
        }

        ir = await extract(false);
        return renderBitmap(ir, mimeType, quality);
      }
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
        const w = new writers.PDFWriter({
          pageWidth: width * PX_TO_MM,
          pageHeight: height * PX_TO_MM,
        });
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
        data = await renderBitmapWithFallback(mime);
        break;
      }
      case 'jpeg': {
        mime = 'image/jpeg';
        ext = '.jpg';
        data = await renderBitmapWithFallback(mime, 0.92);
        break;
      }
      case 'webp': {
        mime = 'image/webp';
        ext = '.webp';
        data = await renderBitmapWithFallback(mime, 0.90);
        break;
      }

      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    // ── Convert to data-URL ───────────────────────────────
    const blob = createExportBlob(data, mime);

    // ── Build filename ────────────────────────────────────
    const title = (document.title || 'export')
      .replace(/[<>:"/\\|?*]+/g, '_')
      .substring(0, 80);
    const filename = `${title}${ext}`;

    // ── Send to background → chrome.downloads ─────────────
    await sendExportResult(blob, filename);
  } catch (err) {
    await reportExportError(err);
  }
})();

async function sendExportResult(blob, filename) {
  const transferId = createExportTransferId();

  await sendTransferMessage({
    type: 'export-transfer-start',
    transferId,
    filename,
    mime: blob.type || 'application/octet-stream',
    size: blob.size,
  });

  for (let offset = 0; offset < blob.size; offset += EXPORT_STREAM_CHUNK_BYTES) {
    const chunkBase64 = await blobChunkToBase64(blob.slice(offset, offset + EXPORT_STREAM_CHUNK_BYTES));
    await sendTransferMessage({
      type: 'export-transfer-chunk',
      transferId,
      chunkBase64,
    });
  }

  await sendTransferMessage({
    type: 'export-transfer-complete',
    transferId,
  });
}

async function sendTransferMessage(message) {
  const response = await extensionApi.runtime.sendMessage(message);

  if (!response || response.ok !== true) {
    throw new Error(response?.error || 'Export transfer did not receive an acknowledgement');
  }

  return response;
}

async function reportExportError(err) {
  try {
    await extensionApi.runtime.sendMessage({
      type: 'export-error',
      error: String(err?.message ?? err),
    });
  } catch {
    // Ignore missing receivers while bubbling the original error to the console.
  }
}

async function resolveUnsafeImageSourcesViaExtension(irNodes) {
  return replaceUnsafeImageSources(irNodes, async (source) => {
    const response = await extensionApi.runtime.sendMessage({
      type: 'fetch-image-data-url',
      url: source,
    });

    if (!response || response.ok !== true || typeof response.dataUrl !== 'string') {
      return null;
    }

    return response.dataUrl;
  });
}

function blobChunkToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to serialize export chunk'));
        return;
      }

      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read export chunk'));
    reader.readAsDataURL(blob);
  });
}

function isTaintedCanvasError(err) {
  return err instanceof DOMException &&
    (err.name === 'SecurityError' || err.message.includes('Tainted'));
}

function logBitmapFallbackDiagnostics(details) {
  const { format, imageNodeCount, filteredImageNodeCount, taintedImages, inaccessibleIframes } = details;

  if (taintedImages.length === 0 && inaccessibleIframes.length === 0) return;

  const summary = {
    format,
    imageNodeCount,
    filteredImageNodeCount,
    removedImageCount: Math.max(0, imageNodeCount - filteredImageNodeCount),
    taintedImageCount: taintedImages.length,
    inaccessibleIframeCount: inaccessibleIframes.length,
  };

  const unsafeImageRows = taintedImages.slice(0, 20).map((image) => ({
    classification: image.classification,
    originalType: image.originalType,
    xpath: image.xpath,
    url: truncateForLog(image.resolvedUrl ?? image.source),
  }));
  const iframeRows = inaccessibleIframes.slice(0, 20).map((iframe) => ({
    reason: iframe.reason,
    title: iframe.title,
    src: truncateForLog(iframe.src),
    errorName: iframe.errorName,
  }));

  if (typeof console.groupCollapsed === 'function') {
    console.groupCollapsed(`[Web2Vector] Bitmap export hit a tainted canvas for ${format}`);
    console.warn('[Web2Vector] Bitmap export diagnostics', summary);

    if (unsafeImageRows.length > 0) {
      console.warn('[Web2Vector] Suspect image sources', unsafeImageRows);
    }

    if (iframeRows.length > 0) {
      console.warn('[Web2Vector] Inaccessible iframes', iframeRows);
    }

    console.groupEnd();
    return;
  }

  console.warn('[Web2Vector] Bitmap export diagnostics', {
    ...summary,
    taintedImages: unsafeImageRows,
    inaccessibleIframes: iframeRows,
  });
}

function countImageNodes(irNodes) {
  return irNodes.reduce((count, node) => count + (node?.type === 'image' ? 1 : 0), 0);
}

function truncateForLog(value, maxLength = 240) {
  if (typeof value !== 'string' || value.length <= maxLength) return value ?? null;
  return `${value.slice(0, maxLength - 3)}...`;
}
