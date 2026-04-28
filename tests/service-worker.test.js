import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FORMATS } from '../src/shared/formats.js';

// ── Minimal chrome API stubs ──────────────────────────────
function createChromeStub() {
  const listeners = {};
  return {
    runtime: {
      onInstalled: { addListener: (fn) => { listeners.onInstalled = fn; } },
      onMessage:   { addListener: (fn) => { listeners.onMessage = fn; } },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    contextMenus: {
      create: vi.fn(),
      onClicked: { addListener: (fn) => { listeners.onClicked = fn; } },
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 42 }]),
    },
    downloads: {
      download: vi.fn().mockResolvedValue(1001),
      onChanged: { addListener: (fn) => { listeners.onDownloadChanged = fn; } },
    },
    _listeners: listeners,
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe('service-worker message handling', () => {
  let chrome;

  beforeEach(() => {
    vi.resetModules();
    chrome = createChromeStub();
    delete globalThis.browser;
    globalThis.chrome = chrome;
  });

  it('creates context-menu entries on install', async () => {
    await import('../src/background/service-worker.js');
    chrome._listeners.onInstalled?.();
    expect(chrome.contextMenus.create).toHaveBeenCalledTimes(Object.keys(FORMATS).length + 1);
  });

  it('injects correct scripts for a core format (svg)', async () => {
    await import('../src/background/service-worker.js');
    chrome._listeners.onMessage?.({ action: 'export', format: 'svg' }, {});

    // Wait for the async chain (tabs.query → startExport → executeScript)
    await vi.waitFor(() => {
      const calls = chrome.scripting.executeScript.mock.calls;
      const fileArgs = calls
        .filter((c) => c[0].files)
        .map((c) => c[0].files)
        .flat();
      expect(fileArgs).toContain('core-lib.js');
    }, { timeout: 2000 });

    const fileArgs = chrome.scripting.executeScript.mock.calls
      .filter((c) => c[0].files)
      .map((c) => c[0].files)
      .flat();

    expect(fileArgs).toContain('run-export.js');
    expect(fileArgs).not.toContain('dxf-writer.js');
    expect(fileArgs).not.toContain('acad-writers.js');
  });

  it('injects frame support into all frames before export', async () => {
    await import('../src/background/service-worker.js');
    chrome._listeners.onMessage?.({ action: 'export', format: 'svg' }, {});

    await vi.waitFor(() => {
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({
            tabId: 42,
            allFrames: true,
          }),
          files: ['core-lib.js', 'frame-support.js'],
        }),
      );
    }, { timeout: 2000 });
  });

  it('skips transferring oversized precomputed IR back into the tab', async () => {
    const hugeDataUrl = `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}`;
    chrome.scripting.executeScript.mockImplementation(async (config) => {
      if (config?.target?.allFrames && Array.isArray(config?.args) && config.args.length === 1) {
        return [{
          frameId: 0,
          result: {
            frameKey: 'root-frame',
            ir: [{
              type: 'image',
              quad: [
                { x: 0, y: 0 },
                { x: 1, y: 0 },
                { x: 1, y: 1 },
                { x: 0, y: 1 },
              ],
              dataUrl: hugeDataUrl,
              width: 1,
              height: 1,
              style: {},
              zIndex: 0,
              source: {
                xpath: '/html/body/img',
                originalType: 'img',
              },
            }],
            childFrames: [],
            paintOrder: ['/html/body/img'],
          },
        }];
      }

      return [];
    });

    await import('../src/background/service-worker.js');
    chrome._listeners.onMessage?.({ action: 'export', format: 'svg' }, {});

    await vi.waitFor(() => {
      const setterCall = chrome.scripting.executeScript.mock.calls.find((call) =>
        typeof call[0]?.func === 'function'
        && Array.isArray(call[0]?.args)
        && call[0].args[0] === 'svg'
      );

      expect(setterCall).toBeTruthy();
      expect(setterCall[0].args[1]).toBeNull();
    }, { timeout: 2000 });
  });

  it('lazy-loads dxf-writer.js for dxf-standard', async () => {
    await import('../src/background/service-worker.js');
    chrome._listeners.onMessage?.({ action: 'export', format: 'dxf-standard' }, {});

    await vi.waitFor(() => {
      const fileArgs = chrome.scripting.executeScript.mock.calls
        .filter((c) => c[0].files)
        .map((c) => c[0].files)
        .flat();
      expect(fileArgs).toContain('dxf-writer.js');
    }, { timeout: 2000 });
  });

  it('lazy-loads acad-writers.js for dwg', async () => {
    await import('../src/background/service-worker.js');
    chrome._listeners.onMessage?.({ action: 'export', format: 'dwg' }, {});

    await vi.waitFor(() => {
      const fileArgs = chrome.scripting.executeScript.mock.calls
        .filter((c) => c[0].files)
        .map((c) => c[0].files)
        .flat();
      expect(fileArgs).toContain('acad-writers.js');
    }, { timeout: 2000 });
  });

  it('triggers download with saveAs on export-result', async () => {
    await import('../src/background/service-worker.js');
    chrome._listeners.onMessage?.(
      {
        type: 'export-result',
        dataUrl: 'data:text/plain;base64,dGVzdA==',
        filename: 'test.svg',
      },
      { tab: { id: 42 } },
    );

    await vi.waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'data:text/plain;base64,dGVzdA==',
          saveAs: true,
          filename: 'test.svg',
        }),
      );
    }, { timeout: 2000 });
  });

  it('fetches image bytes via the service worker and returns a data URL', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: vi.fn().mockResolvedValue(new Blob([
        Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
      ], { type: 'image/png' })),
    });

    try {
      await import('../src/background/service-worker.js');
      const sendResponse = vi.fn();
      const keepChannelOpen = chrome._listeners.onMessage?.(
        {
          type: 'fetch-image-data-url',
          url: 'https://cdn.example.net/logo.png',
        },
        {},
        sendResponse,
      );

      expect(keepChannelOpen).toBe(true);

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith(
          expect.objectContaining({
            ok: true,
            dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
          }),
        );
      }, { timeout: 2000 });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://cdn.example.net/logo.png',
        expect.objectContaining({
          credentials: 'include',
          redirect: 'follow',
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses blob URLs for Firefox data-url downloads', async () => {
    const browser = createChromeStub();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    delete globalThis.chrome;
    globalThis.browser = browser;
    URL.createObjectURL = vi.fn(() => 'blob:firefox-download');
    URL.revokeObjectURL = vi.fn();

    try {
      await import('../src/background/service-worker.js');
      browser._listeners.onMessage?.(
        {
          type: 'export-result',
          dataUrl: 'data:text/plain;base64,dGVzdA==',
          filename: 'test.txt',
        },
        { tab: { id: 42 } },
      );

      await vi.waitFor(() => {
        expect(browser.downloads.download).toHaveBeenCalledWith(
          expect.objectContaining({
            url: 'blob:firefox-download',
            saveAs: true,
            filename: 'test.txt',
          }),
        );
      }, { timeout: 2000 });

      browser._listeners.onDownloadChanged?.({
        id: 1001,
        state: { current: 'complete' },
      });

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:firefox-download');
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      delete globalThis.browser;
      globalThis.chrome = chrome;
    }
  });

  it('assembles streamed export chunks into a blob download', async () => {
    await import('../src/background/service-worker.js');
    const sendResponse = vi.fn();
    chrome._listeners.onMessage?.({
      type: 'export-transfer-start',
      transferId: 'transfer-1',
      filename: 'streamed.pdf',
      mime: 'application/pdf',
      size: 4,
    }, { tab: { id: 42 }, frameId: 0, documentId: 'doc-1' }, sendResponse);
    chrome._listeners.onMessage?.({
      type: 'export-transfer-chunk',
      transferId: 'transfer-1',
      chunkBase64: 'AQI=',
    }, { tab: { id: 42 }, frameId: 0, documentId: 'doc-1' }, sendResponse);
    chrome._listeners.onMessage?.({
      type: 'export-transfer-chunk',
      transferId: 'transfer-1',
      chunkBase64: 'AwQ=',
    }, { tab: { id: 42 }, frameId: 0, documentId: 'doc-1' }, sendResponse);

    const keepChannelOpen = chrome._listeners.onMessage?.(
      { type: 'export-transfer-complete', transferId: 'transfer-1' },
      { tab: { id: 42 }, frameId: 0, documentId: 'doc-1' },
      sendResponse,
    );

    expect(keepChannelOpen).toBe(true);

    await vi.waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'data:application/pdf;base64,AQIDBA==',
          filename: 'streamed.pdf',
          saveAs: true,
        }),
      );
    }, { timeout: 2000 });

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    }, { timeout: 2000 });
  });

  it('completes the transfer before the download promise resolves', async () => {
    const downloadDeferred = createDeferred();

    chrome.downloads.download.mockReturnValueOnce(downloadDeferred.promise);

    await import('../src/background/service-worker.js');
    const sendResponse = vi.fn();
    chrome._listeners.onMessage?.({
      type: 'export-transfer-start',
      transferId: 'transfer-2',
      filename: 'pending.pdf',
      mime: 'application/pdf',
      size: 2,
    }, { tab: { id: 42 }, frameId: 0, documentId: 'doc-2' }, sendResponse);
    chrome._listeners.onMessage?.({
      type: 'export-transfer-chunk',
      transferId: 'transfer-2',
      chunkBase64: 'AQI=',
    }, { tab: { id: 42 }, frameId: 0, documentId: 'doc-2' }, sendResponse);

    chrome._listeners.onMessage?.(
      { type: 'export-transfer-complete', transferId: 'transfer-2' },
      { tab: { id: 42 }, frameId: 0, documentId: 'doc-2' },
      sendResponse,
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    }, { timeout: 2000 });

    await vi.waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'data:application/pdf;base64,AQI=',
          filename: 'pending.pdf',
          saveAs: true,
        }),
      );
    }, { timeout: 2000 });

    downloadDeferred.resolve(2002);

    await vi.waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'export-complete' });
    }, { timeout: 2000 });
  });

  it('uses blob URLs for Firefox streamed downloads', async () => {
    const browser = createChromeStub();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    delete globalThis.chrome;
    globalThis.browser = browser;
    URL.createObjectURL = vi.fn(() => 'blob:firefox-streamed-download');
    URL.revokeObjectURL = vi.fn();

    try {
      await import('../src/background/service-worker.js');
      const sendResponse = vi.fn();
      browser._listeners.onMessage?.({
        type: 'export-transfer-start',
        transferId: 'transfer-3',
        filename: 'streamed.txt',
        mime: 'text/plain',
        size: 4,
      }, { tab: { id: 42 }, frameId: 0, documentId: 'doc-3' }, sendResponse);
      browser._listeners.onMessage?.({
        type: 'export-transfer-chunk',
        transferId: 'transfer-3',
        chunkBase64: 'dGVzdA==',
      }, { tab: { id: 42 }, frameId: 0, documentId: 'doc-3' }, sendResponse);
      browser._listeners.onMessage?.(
        { type: 'export-transfer-complete', transferId: 'transfer-3' },
        { tab: { id: 42 }, frameId: 0, documentId: 'doc-3' },
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(browser.downloads.download).toHaveBeenCalledWith(
          expect.objectContaining({
            url: 'blob:firefox-streamed-download',
            filename: 'streamed.txt',
            saveAs: true,
          }),
        );
      }, { timeout: 2000 });

      browser._listeners.onDownloadChanged?.({
        id: 1001,
        state: { current: 'complete' },
      });

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:firefox-streamed-download');
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      delete globalThis.browser;
      globalThis.chrome = chrome;
    }
  });

  it('accepts streamed transfer messages without sender.tab', async () => {
    await import('../src/background/service-worker.js');
    const sendResponse = vi.fn();

    chrome._listeners.onMessage?.({
      type: 'export-transfer-start',
      transferId: 'transfer-4',
      filename: 'no-tab.pdf',
      mime: 'application/pdf',
      size: 2,
    }, { frameId: 0, documentId: 'doc-no-tab' }, sendResponse);
    chrome._listeners.onMessage?.({
      type: 'export-transfer-chunk',
      transferId: 'transfer-4',
      chunkBase64: 'AQI=',
    }, { frameId: 0, documentId: 'doc-no-tab' }, sendResponse);

    chrome._listeners.onMessage?.(
      { type: 'export-transfer-complete', transferId: 'transfer-4' },
      { frameId: 0, documentId: 'doc-no-tab' },
      sendResponse,
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'data:application/pdf;base64,AQI=',
          filename: 'no-tab.pdf',
          saveAs: true,
        }),
      );
    }, { timeout: 2000 });
  });
});
