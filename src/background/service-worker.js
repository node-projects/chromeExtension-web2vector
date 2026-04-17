import { FORMATS, CATEGORIES } from '../shared/formats.js';
import { extensionApi } from '../shared/extension-api.js';

const pendingDownloadUrls = new Map();

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

// ── Message handling ──────────────────────────────────────
extensionApi.runtime.onMessage.addListener((message, sender) => {
  // From popup: start an export
  if (message.action === 'export') {
    extensionApi.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) startExport(tab.id, message.format);
    });
  }

  // From content script: export finished
  if (message.type === 'export-result' && sender.tab) {
    handleResult(message);
  }

  // From content script: export error
  if (message.type === 'export-error' && sender.tab) {
    notifyPopup('export-error', { error: message.error });
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
    // 1. Set the requested format in the content-script world
    await extensionApi.scripting.executeScript({
      target: { tabId },
      func: (f) => { globalThis.__web2vector_format = f; },
      args: [format],
    });

    // 2. Inject core library (idempotent – skips if already loaded)
    await extensionApi.scripting.executeScript({
      target: { tabId },
      files: ['core-lib.js'],
    });

    // 3. Lazy-load writer bundle when required
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

    // 4. Run the export
    await extensionApi.scripting.executeScript({
      target: { tabId },
      files: ['run-export.js'],
    });
  } catch (err) {
    notifyPopup('export-error', { error: err.message });
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

// ── Notify popup (best-effort – popup may be closed) ──────
function notifyPopup(action, extra = {}) {
  extensionApi.runtime.sendMessage({ action, ...extra }).catch(() => {});
}
