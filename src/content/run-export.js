/**
 * Run-export script — injected each time the user requests an export.
 *
 * Reads the requested format and export options from globalThis,
 * performs the export via layout2vector, converts the result to a
 * data-URL, and sends it to the background service worker which
 * triggers chrome.downloads.download({ saveAs: true }).
 */
import { calculateExportSize } from './export-size.js';
import pako from 'pako';
import { extensionApi } from '../shared/extension-api.js';
import { EXPORT_STREAM_CHUNK_BYTES, createExportTransferId } from '../shared/export-transfer.js';
import { normalizeTransferredFontAssets } from '../shared/font-assets.js';
import {
  collectInaccessibleIframeDiagnostics,
  collectPotentiallyTaintedImageDiagnostics,
  createExportBlob,
  replaceUnsafeImageSources,
  stripPotentiallyTaintedImages,
} from './export-utils.js';

const PX_TO_MM = 25.4 / 96;
const FONT_ASSET_FORMATS = new Set(['html', 'svg', 'pdf']);
const PDF_FONT_SOURCE_PRIORITY = ['ttf', 'otf', 'woff', 'woff2'];
const PDF_CONVERTIBLE_FONT_SOURCE_FORMATS = new Set(['otf', 'woff', 'woff2']);

let fontEditorCorePromise = null;
let woff2InitPromise = null;

(async () => {
  try {
    const format = globalThis.__web2vector_format;
    if (!format) throw new Error('No export format specified');

    const lib = globalThis.__web2vector;
    if (!lib) throw new Error('Core library not loaded');

    const { extractIR, extractIRWithAssets, renderIR, writers } = lib;

    const root = document.documentElement;
    const exportOptions = normalizeExportOptions(globalThis.__web2vector_export_options);
    const shouldCollectFonts = shouldCollectFontAssets(format, exportOptions);
    const precomputedIr = Array.isArray(globalThis.__web2vector_precomputed_ir)
      ? globalThis.__web2vector_precomputed_ir
      : null;
    const precomputedFontAssets = normalizeFontAssets(globalThis.__web2vector_precomputed_font_assets);

    delete globalThis.__web2vector_precomputed_ir;
    delete globalThis.__web2vector_precomputed_font_assets;
    delete globalThis.__web2vector_export_options;

    const BITMAP_FORMATS = ['png', 'jpeg', 'webp'];
    const isBitmap = BITMAP_FORMATS.includes(format);

    // ── Extract IR ────────────────────────────────────────
    async function extract(includeImages) {
      const extractOptions = {
        boxType: 'border',
        includeText: true,
        includeImages,
        includeFonts: shouldCollectFonts,
        includeSourceMetadata: false,
        walkIframes: true,
        rootScrollBehavior: exportOptions.rootScrollBehavior,
        convertFormControls: true,
      };

      if (shouldCollectFonts && typeof extractIRWithAssets === 'function') {
        return extractIRWithAssets(root, extractOptions);
      }

      return {
        ir: await extractIR(root, extractOptions),
      };
    }

    const extracted = precomputedIr
      ? { ir: precomputedIr, fontAssets: precomputedFontAssets }
      : await extract(true);
    let ir = Array.isArray(extracted?.ir) ? extracted.ir : [];
    const fontAssets = normalizeFontAssets(extracted?.fontAssets);
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

        if (precomputedIr) {
          ir = stripAllImages(ir);
          return renderBitmap(ir, mimeType, quality);
        }

        ir = await extract(false);
        return renderBitmap(ir, mimeType, quality);
      }
    }

    switch (format) {
      /* ── Vector ── */
      case 'svg': {
        const w = new writers.SVGWriter({
          width,
          height,
          fontAssets,
          fontMode: fontAssets ? { type: 'inline' } : { type: 'none' },
        });
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
        const pdfFontAssets = await preparePdfFontAssets(fontAssets, exportOptions.pdfUseFontEditorCore);

        const w = new writers.PDFWriter({
          pageWidth: width * PX_TO_MM,
          pageHeight: height * PX_TO_MM,
          fontAssets: pdfFontAssets,
          // We normalize assets to TTF up-front so writer-level conversion is not required.
          useFontEditorCore: false,
        });
        const doc = await renderIR(ir, w);
        await doc.finalize();
        data = doc.toBytes();
        mime = 'application/pdf';
        ext = '.pdf';
        break;
      }
      case 'html': {
        const w = new writers.HTMLWriter({
          width,
          height,
          fontAssets,
          fontMode: fontAssets ? { type: 'inline' } : { type: 'none' },
        });
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

function stripAllImages(irNodes) {
  return irNodes.filter((node) => node?.type !== 'image');
}

function truncateForLog(value, maxLength = 240) {
  if (typeof value !== 'string' || value.length <= maxLength) return value ?? null;
  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizeExportOptions(options) {
  return {
    rootScrollBehavior: options?.rootScrollBehavior === 'expand' ? 'expand' : 'clip',
    embedFonts: options?.embedFonts !== false,
    pdfUseFontEditorCore: options?.pdfUseFontEditorCore !== false,
  };
}

function shouldCollectFontAssets(format, exportOptions) {
  return FONT_ASSET_FORMATS.has(format) && exportOptions?.embedFonts !== false;
}

function normalizeFontAssets(fontAssets) {
  return normalizeTransferredFontAssets(fontAssets);
}

async function preparePdfFontAssets(fontAssets, allowConversion) {
  if (!fontAssets || !Array.isArray(fontAssets.faces) || fontAssets.faces.length === 0) {
    return undefined;
  }

  const faces = [];

  for (const face of fontAssets.faces) {
    const convertedSource = await pickPdfFontSource(face, allowConversion);
    if (!convertedSource) continue;

    faces.push({
      ...face,
      sources: [convertedSource],
    });
  }

  return faces.length > 0 ? { faces } : undefined;
}

async function pickPdfFontSource(face, allowConversion) {
  const candidates = rankPdfFontSources(face?.sources);

  for (const source of candidates) {
    const data = toUint8Array(source?.data);
    const format = resolveFontSourceFormat(source?.format, data);
    if (!format || !data) continue;

    if (format === 'ttf') {
      return {
        ...source,
        format: 'ttf',
        mimeType: 'font/ttf',
        data,
      };
    }

    if (!allowConversion || !PDF_CONVERTIBLE_FONT_SOURCE_FORMATS.has(format)) {
      continue;
    }

    try {
      const convertedData = await convertFontSourceToTtf(data, format);
      if (!convertedData) continue;

      return {
        ...source,
        format: 'ttf',
        mimeType: 'font/ttf',
        data: convertedData,
      };
    } catch (error) {
      console.warn(
        `[Web2Vector] Failed to convert font source to TTF for PDF (${face?.family || 'unknown family'}, ${format}):`,
        error
      );
    }
  }

  return null;
}

function rankPdfFontSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return [];

  return [...sources]
    .map((source) => ({
      source,
      format: normalizeFontSourceFormat(source?.format),
    }))
    .filter((entry) => Boolean(entry.format))
    .sort((left, right) => {
      const leftRank = getPdfFontSourcePriority(left.format);
      const rightRank = getPdfFontSourcePriority(right.format);

      return leftRank - rightRank;
    })
    .map((entry) => entry.source);
}

function getPdfFontSourcePriority(format) {
  const rank = PDF_FONT_SOURCE_PRIORITY.indexOf(format);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function normalizeFontSourceFormat(format) {
  if (typeof format !== 'string') return null;
  return format.trim().toLowerCase();
}

function resolveFontSourceFormat(declaredFormat, data) {
  const detectedFormat = detectFontBinaryFormat(data);
  if (detectedFormat) {
    return detectedFormat;
  }

  return normalizeFontSourceFormat(declaredFormat);
}

function detectFontBinaryFormat(data) {
  if (!(data instanceof Uint8Array) || data.length < 4) return null;

  const signature = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (signature === 'wOFF') return 'woff';
  if (signature === 'wOF2') return 'woff2';
  if (signature === 'OTTO') return 'otf';
  if (signature === 'true') return 'ttf';
  if (data[0] === 0x00 && data[1] === 0x01 && data[2] === 0x00 && data[3] === 0x00) return 'ttf';

  return null;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }

  return null;
}

function toArrayBufferCopy(value) {
  const data = toUint8Array(value);
  if (!data) return null;

  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

async function convertFontSourceToTtf(data, format) {
  const normalizedFormat = normalizeFontSourceFormat(format);
  if (normalizedFormat === 'ttf') {
    return data;
  }

  if (!PDF_CONVERTIBLE_FONT_SOURCE_FORMATS.has(normalizedFormat)) {
    return null;
  }

  const fontEditorCore = await getFontEditorCore();
  if (!fontEditorCore?.createFont) {
    return null;
  }

  if (normalizedFormat === 'woff2') {
    await ensureWoff2Runtime(fontEditorCore);
  }

  const fontBuffer = toArrayBufferCopy(data);
  if (!fontBuffer) {
    return null;
  }

  const readOptions = {
    type: normalizedFormat,
  };

  if (normalizedFormat === 'woff') {
    readOptions.inflate = (compressedData) => pako.inflate(compressedData);
  }

  const font = fontEditorCore.createFont(fontBuffer, readOptions);
  const ttfBuffer = font.write({
    type: 'ttf',
    toBuffer: false,
  });

  return toUint8Array(ttfBuffer);
}

async function getFontEditorCore() {
  if (!fontEditorCorePromise) {
    fontEditorCorePromise = import('../../node_modules/fonteditor-core/lib/main.js')
      .then((mod) => mod?.default ?? mod)
      .catch((error) => {
        fontEditorCorePromise = null;
        throw error;
      });
  }

  return fontEditorCorePromise;
}

async function ensureWoff2Runtime(fontEditorCore) {
  if (fontEditorCore?.woff2?.isInited?.()) {
    return;
  }

  if (!fontEditorCore?.woff2?.init) {
    throw new Error('fonteditor-core WOFF2 runtime is unavailable');
  }

  if (!woff2InitPromise) {
    const wasmUrl = resolveWoff2WasmUrl();
    if (!wasmUrl) {
      throw new Error('Unable to resolve WOFF2 wasm URL');
    }

    woff2InitPromise = fontEditorCore.woff2.init(wasmUrl).catch((error) => {
      woff2InitPromise = null;
      throw error;
    });
  }

  await woff2InitPromise;
}

function resolveWoff2WasmUrl() {
  return typeof extensionApi?.runtime?.getURL === 'function'
    ? extensionApi.runtime.getURL('woff2.wasm')
    : null;
}
