import { FORMATS, CATEGORIES } from '../shared/formats.js';

// ── Context-menu setup ────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'web2vector',
    title: 'Web2Vector Export',
    contexts: ['page'],
  });

  for (const [id, fmt] of Object.entries(FORMATS)) {
    chrome.contextMenus.create({
      id: `export-${id}`,
      parentId: 'web2vector',
      title: `${fmt.name} (${fmt.ext})`,
      contexts: ['page'],
    });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.menuItemId.startsWith('export-')) return;
  const format = info.menuItemId.slice('export-'.length);
  startExport(tab.id, format);
});

// ── Message handling ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender) => {
  // From popup: start an export
  if (message.action === 'export') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
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
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (f) => { globalThis.__web2vector_format = f; },
      args: [format],
    });

    // 2. Inject core library (idempotent – skips if already loaded)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['core-lib.js'],
    });

    // 3. Lazy-load writer bundle when required
    if (fmt.bundle === 'dxf') {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['dxf-writer.js'],
      });
    } else if (fmt.bundle === 'acad') {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['acad-writers.js'],
      });
    }

    // 4. Run the export
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['run-export.js'],
    });
  } catch (err) {
    notifyPopup('export-error', { error: err.message });
  }
}

// ── Download handling ─────────────────────────────────────
async function handleResult({ dataUrl, filename }) {
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: true,
    });
    notifyPopup('export-complete');
  } catch (err) {
    notifyPopup('export-error', { error: err.message });
  }
}

// ── Notify popup (best-effort – popup may be closed) ──────
function notifyPopup(action, extra = {}) {
  chrome.runtime.sendMessage({ action, ...extra }).catch(() => {});
}
