import { FORMATS, CATEGORIES } from '../shared/formats.js';
import { extensionApi } from '../shared/extension-api.js';
import { base64ToBytes } from '../shared/export-transfer.js';
import { mergeFrameExtractionResults } from '../shared/frame-merge.js';
import { POPUP_STATUS_PORT_NAME } from '../shared/popup-status.js';

const pendingDownloadUrls = new Map();
const pendingTransfers = new Map();
const popupPorts = new Set();
const IMAGE_FETCH_TIMEOUT_MS = 12000;
const FRAME_COLLECTION_TIMEOUT_MS = 45000;
const PRECOMPUTED_IR_TRANSFER_MAX_BYTES = 8 * 1024 * 1024;

const FRAME_EXTRACTION_OPTIONS = {
  boxType: 'border',
  includeText: true,
  includeImages: true,
  includeSourceMetadata: true,
  includeInvisible: false,
  convertFormControls: true,
  includePseudoElements: true,
};

extensionApi.downloads.onChanged?.addListener((delta) => {
  const state = delta.state?.current;
  if (!state || (state !== 'complete' && state !== 'interrupted')) return;

  const objectUrl = pendingDownloadUrls.get(delta.id);
  if (!objectUrl) return;

  URL.revokeObjectURL(objectUrl);
  pendingDownloadUrls.delete(delta.id);
});

// ── Context-menu setup ────────────────────────────────────
extensionApi.runtime.onInstalled.addListener(() => {
  extensionApi.contextMenus.create({
    id: 'web2vector',
    title: 'Web2Vector Export',
    contexts: ['page'],
  });

  for (const [id, fmt] of Object.entries(FORMATS)) {
    extensionApi.contextMenus.create({
      id: `export-${id}`,
      parentId: 'web2vector',
      title: `${fmt.name} (${fmt.ext})`,
      contexts: ['page'],
    });
  }
});

extensionApi.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.menuItemId.startsWith('export-')) return;
  const format = info.menuItemId.slice('export-'.length);
  startExport(tab.id, format);
});

extensionApi.runtime.onConnect?.addListener((port) => {
  if (port.name !== POPUP_STATUS_PORT_NAME) return;

  popupPorts.add(port);
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
});

// ── Message handling ──────────────────────────────────────
extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // From popup: start an export
  if (message.action === 'export') {
    extensionApi.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) startExport(tab.id, message.format);
    });
    return;
  }

  // From content script: export finished
  if (message.type === 'export-result') {
    handleResult(message);
    return;
  }

  // From content script: export error
  if (message.type === 'export-error') {
    notifyPopup('export-error', { error: message.error });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'fetch-image-data-url') {
    void fetchImageDataUrl(message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'export-transfer-start') {
    sendResponse(handleTransferStart(message, sender));
    return;
  }

  if (message.type === 'export-transfer-chunk') {
    sendResponse(handleTransferChunk(message, sender));
    return;
  }

  if (message.type === 'export-transfer-complete') {
    void finalizeTransfer(message, sender)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

// ── Export orchestration ──────────────────────────────────
async function startExport(tabId, format) {
  const fmt = FORMATS[format];
  if (!fmt) {
    notifyPopup('export-error', { error: `Unknown format: ${format}` });
    return;
  }

  try {
    const mergedIr = selectPrecomputedIrForTransfer(await collectMergedIrForTab(tabId));

    // 1. Set the requested format and precomputed IR in the content-script world
    await extensionApi.scripting.executeScript({
      target: { tabId },
      func: (f, ir) => {
        globalThis.__web2vector_format = f;

        if (Array.isArray(ir)) {
          globalThis.__web2vector_precomputed_ir = ir;
        } else {
          delete globalThis.__web2vector_precomputed_ir;
        }
      },
      args: [format, mergedIr],
    });

    // 2. Lazy-load writer bundle when required
    if (fmt.bundle === 'dxf') {
      await extensionApi.scripting.executeScript({
        target: { tabId },
        files: ['dxf-writer.js'],
      });
    } else if (fmt.bundle === 'acad') {
      await extensionApi.scripting.executeScript({
        target: { tabId },
        files: ['acad-writers.js'],
      });
    }

    // 3. Run the export
    await extensionApi.scripting.executeScript({
      target: { tabId },
      files: ['run-export.js'],
    });
  } catch (err) {
    notifyPopup('export-error', { error: err.message });
  }
}

async function collectMergedIrForTab(tabId) {
  try {
    return await withTimeout((async () => {
      await extensionApi.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['core-lib.js', 'frame-support.js'],
      });

      await extensionApi.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => globalThis.__web2vectorFrameSupport?.prepare?.() ?? null,
      });

      const frameResults = await extensionApi.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (options) => globalThis.__web2vectorFrameSupport?.collectFrameData?.(options) ?? null,
        args: [FRAME_EXTRACTION_OPTIONS],
      });

      return mergeFrameExtractionResults(frameResults, { rootFrameId: 0 })?.ir ?? null;
    })(), FRAME_COLLECTION_TIMEOUT_MS, () => {
      console.warn('[Web2Vector] Timed out while collecting merged frame IR; falling back to in-page extraction.');
      return null;
    });
  } catch {
    return null;
  }
}

function selectPrecomputedIrForTransfer(ir) {
  if (!Array.isArray(ir)) return null;

  const estimatedBytes = estimateSerializedSize(ir);
  if (estimatedBytes <= PRECOMPUTED_IR_TRANSFER_MAX_BYTES) {
    return ir;
  }

  console.warn(
    `[Web2Vector] Skipping precomputed IR transfer (${estimatedBytes} bytes > ${PRECOMPUTED_IR_TRANSFER_MAX_BYTES}); falling back to in-page extraction.`
  );
  return null;
}

function estimateSerializedSize(value) {
  try {
    return JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function withTimeout(promise, timeoutMs, onTimeout) {
  let timeoutId = null;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = globalThis.setTimeout(() => {
      resolve(onTimeout());
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

// ── Download handling ─────────────────────────────────────
async function handleResult({ dataUrl, filename }) {
  const objectUrl = createDownloadObjectUrl(dataUrl);

  try {
    const downloadId = await extensionApi.downloads.download({
      url: objectUrl ?? dataUrl,
      filename,
      saveAs: true,
    });

    if (objectUrl !== null) {
      pendingDownloadUrls.set(downloadId, objectUrl);
    }

    notifyPopup('export-complete');
  } catch (err) {
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
    }

    notifyPopup('export-error', { error: err.message });
  }
}

function handleTransferStart(message, sender) {
  if (!message.transferId || typeof message.transferId !== 'string') {
    return { ok: false, error: 'Missing export transfer id' };
  }

  pendingTransfers.set(getTransferKey(sender, message.transferId), {
    filename: message.filename,
    mime: message.mime || 'application/octet-stream',
    expectedSize: message.size ?? null,
    receivedSize: 0,
    chunks: [],
  });

  return { ok: true };
}

function handleTransferChunk(message, sender) {
  try {
    const transfer = requireTransfer(message, sender);
    const chunk = decodeExportChunk(message.chunkBase64);
    transfer.chunks.push(chunk);
    transfer.receivedSize += chunk.byteLength;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function finalizeTransfer(message, sender) {
  const transfer = requireTransfer(message, sender);
  const transferKey = getTransferKey(sender, message.transferId);

  try {
    if (transfer.expectedSize !== null && transfer.receivedSize !== transfer.expectedSize) {
      throw new Error('Export stream ended before all bytes were received');
    }

    const blob = new Blob(transfer.chunks, { type: transfer.mime });
    void handleResultBlob(blob, transfer.filename).catch(() => {});
    return { ok: true };
  } finally {
    pendingTransfers.delete(transferKey);
  }
}

async function handleResultBlob(blob, filename) {
  let objectUrl = null;

  try {
    const downloadTarget = await createDownloadTargetFromBlob(blob);
    objectUrl = downloadTarget.objectUrl;
    const downloadId = await extensionApi.downloads.download({
      url: downloadTarget.url,
      filename,
      saveAs: true,
    });

    if (objectUrl !== null) {
      pendingDownloadUrls.set(downloadId, objectUrl);
    }

    notifyPopup('export-complete');
  } catch (err) {
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
    }

    notifyPopup('export-error', { error: err.message });
    throw err;
  }
}

async function fetchImageDataUrl(message) {
  if (typeof message?.url !== 'string' || message.url.length === 0) {
    return { ok: false, error: 'Missing image URL' };
  }

  try {
    const response = await fetchWithTimeout(message.url, IMAGE_FETCH_TIMEOUT_MS, {
      credentials: 'include',
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Image request failed with status ${response.status}`);
    }

    const blob = await response.blob();
    const dataUrl = await blobToImageDataUrl(blob, message.url);
    return { ok: true, dataUrl };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

async function fetchWithTimeout(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function createDownloadTargetFromBlob(blob) {
  if (shouldUseObjectUrlForBlobDownload()) {
    const objectUrl = URL.createObjectURL(blob);
    return { url: objectUrl, objectUrl };
  }

  return {
    url: await blobToDataUrl(blob),
    objectUrl: null,
  };
}

function shouldUseObjectUrlForBlobDownload() {
  return extensionApi === globalThis.browser &&
    typeof URL.createObjectURL === 'function';
}

function createDownloadObjectUrl(dataUrl) {
  if (!shouldUseObjectUrlForDownload(dataUrl)) return null;
  return URL.createObjectURL(dataUrlToBlob(dataUrl));
}

function shouldUseObjectUrlForDownload(dataUrl) {
  return typeof dataUrl === 'string' &&
    dataUrl.startsWith('data:') &&
    extensionApi === globalThis.browser &&
    typeof URL.createObjectURL === 'function';
}

function dataUrlToBlob(dataUrl) {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) {
    throw new Error('Invalid download payload');
  }

  const header = dataUrl.slice(5, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const isBase64 = header.endsWith(';base64');
  const mime = header.replace(/;base64$/, '') || 'application/octet-stream';
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  return `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
}

async function blobToImageDataUrl(blob, sourceUrl) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = detectImageMimeType(bytes, blob.type, sourceUrl);

  if (!mime) {
    throw new Error('Fetched resource was not a supported image');
  }

  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function detectImageMimeType(bytes, declaredType, sourceUrl) {
  const normalizedDeclaredType = normalizeMimeType(declaredType);
  if (normalizedDeclaredType?.startsWith('image/')) {
    return normalizedDeclaredType;
  }

  if (looksLikeSvgPayload(bytes) || looksLikeSvgUrl(sourceUrl)) {
    return 'image/svg+xml';
  }

  if (matchesSignature(bytes, [0x89, 0x50, 0x4E, 0x47])) return 'image/png';
  if (matchesSignature(bytes, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (matchesSignature(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (matchesSignature(bytes, [0x42, 0x4D])) return 'image/bmp';
  if (matchesSignature(bytes, [0x52, 0x49, 0x46, 0x46]) && matchesSignature(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp';
  }

  return null;
}

function normalizeMimeType(mime) {
  if (typeof mime !== 'string' || mime.length === 0) return null;
  return mime.split(';', 1)[0].trim().toLowerCase() || null;
}

function matchesSignature(bytes, signature) {
  if (bytes.length < signature.length) return false;

  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }

  return true;
}

function looksLikeSvgPayload(bytes) {
  if (bytes.length === 0) return false;

  const sample = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
  return sample.replace(/^\uFEFF/, '').trimStart().startsWith('<svg');
}

function looksLikeSvgUrl(sourceUrl) {
  try {
    return new URL(sourceUrl).pathname.toLowerCase().endsWith('.svg');
  } catch {
    return false;
  }
}

function decodeExportChunk(chunkBase64) {
  if (typeof chunkBase64 !== 'string' || chunkBase64.length === 0) {
    throw new Error('Invalid export chunk payload');
  }

  return base64ToBytes(chunkBase64);
}

function requireTransfer(message, sender) {
  const transferId = message?.transferId;
  if (!transferId || typeof transferId !== 'string') {
    throw new Error('Missing export transfer id');
  }

  const transfer = pendingTransfers.get(getTransferKey(sender, transferId));
  if (!transfer) {
    throw new Error('Export stream was not initialized');
  }

  return transfer;
}

function getTransferKey(sender, transferId) {
  const tabId = sender.tab?.id ?? 'no-tab';
  const frameId = sender.frameId ?? 0;
  const documentId = sender.documentId ?? 'no-document';
  return `${tabId}:${frameId}:${documentId}:${transferId}`;
}

// ── Notify popup (best-effort – popup may be closed) ──────
function notifyPopup(action, extra = {}) {
  const message = { action, ...extra };

  for (const port of popupPorts) {
    try {
      port.postMessage(message);
    } catch {
      popupPorts.delete(port);
    }
  }

  extensionApi.runtime.sendMessage(message).catch(() => {});
}
