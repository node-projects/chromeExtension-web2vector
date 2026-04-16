import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    },
    _listeners: listeners,
  };
}

describe('service-worker message handling', () => {
  let chrome;

  beforeEach(() => {
    vi.resetModules();
    chrome = createChromeStub();
    globalThis.chrome = chrome;
  });

  it('creates context-menu entries on install', async () => {
    await import('../src/background/service-worker.js');
    chrome._listeners.onInstalled?.();
    // 1 parent + 10 format sub-items
    expect(chrome.contextMenus.create).toHaveBeenCalledTimes(11);
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
          saveAs: true,
          filename: 'test.svg',
        }),
      );
    }, { timeout: 2000 });
  });
});
