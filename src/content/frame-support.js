import {
  FRAME_KEY_REQUEST_MESSAGE,
  FRAME_KEY_RESPONSE_MESSAGE,
  FRAME_KEY_RESPONSE_TIMEOUT_MS,
} from '../shared/frame-bridge.js';

if (!globalThis.__web2vectorFrameSupport) {
  globalThis.__web2vectorFrameSupport = {
    prepare,
    collectFrameData,
  };
}

prepare();

function prepare() {
  ensureFrameKeyResponder();
  return getFrameKey();
}

async function collectFrameData(options = {}) {
  prepare();

  const root = document.documentElement;
  const lib = globalThis.__web2vector;
  if (!root || !lib) {
    return {
      frameKey: getFrameKey(),
      ir: [],
      childFrames: [],
      paintOrder: [],
    };
  }

  const extractOptions = {
    boxType: options.boxType ?? 'border',
    includeText: options.includeText ?? true,
    includeImages: options.includeImages ?? true,
    includeSourceMetadata: options.includeSourceMetadata ?? true,
    includeInvisible: options.includeInvisible ?? false,
    walkIframes: false,
    convertFormControls: options.convertFormControls ?? true,
    includePseudoElements: options.includePseudoElements ?? true,
  };

  const paintOrder = collectPaintOrder(root, extractOptions.includeInvisible ?? false, lib);
  const ir = await lib.extractIR(root, extractOptions);
  const childFrames = await collectChildFrameMappings(root, extractOptions.includeInvisible ?? false, lib);

  return {
    frameKey: getFrameKey(),
    ir,
    childFrames,
    paintOrder,
  };
}

function collectPaintOrder(root, includeInvisible, lib) {
  if (typeof lib.traverseDOM !== 'function' || typeof lib.flattenStackingOrder !== 'function') {
    return [];
  }

  const stackingTree = lib.traverseDOM(root, includeInvisible, false);
  return lib.flattenStackingOrder(stackingTree).map((node) => getElementXPath(node.element));
}

async function collectChildFrameMappings(root, includeInvisible, lib) {
  const frames = collectIframeElements(root, includeInvisible);
  const mappings = [];

  for (const iframe of frames) {
    const childFrameKey = await requestChildFrameKey(iframe);
    if (!childFrameKey) continue;

    const viewport = getIframeViewportMetadata(iframe, lib);
    if (!viewport) continue;

    mappings.push({
      anchorXPath: getElementXPath(iframe),
      childFrameKey,
      ...viewport,
    });
  }

  return mappings;
}

function collectIframeElements(root, includeInvisible) {
  const results = [];
  const visitedContainers = new Set();

  function visit(container) {
    if (!container || visitedContainers.has(container) || typeof container.querySelectorAll !== 'function') {
      return;
    }

    visitedContainers.add(container);

    for (const element of Array.from(container.querySelectorAll('*'))) {
      if (element?.shadowRoot) {
        visit(element.shadowRoot);
      }

      if (element?.tagName?.toLowerCase() !== 'iframe') continue;
      if (!includeInvisible && !isVisibleElement(element)) continue;

      results.push(element);
    }
  }

  visit(root);
  return results;
}

function isVisibleElement(element) {
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function requestChildFrameKey(iframe) {
  return new Promise((resolve) => {
    const childWindow = iframe.contentWindow;
    if (!childWindow) {
      resolve(null);
      return;
    }

    const token = createFrameToken();
    let timeoutId = null;

    function cleanup() {
      window.removeEventListener('message', handleMessage);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }

    function handleMessage(event) {
      if (event.source !== childWindow) return;

      const data = event.data;
      if (!data || data.type !== FRAME_KEY_RESPONSE_MESSAGE || data.token !== token) return;

      cleanup();
      resolve(typeof data.frameKey === 'string' ? data.frameKey : null);
    }

    window.addEventListener('message', handleMessage);
    timeoutId = setTimeout(() => {
      cleanup();
      resolve(null);
    }, FRAME_KEY_RESPONSE_TIMEOUT_MS);

    try {
      childWindow.postMessage({
        type: FRAME_KEY_REQUEST_MESSAGE,
        token,
      }, '*');
    } catch {
      cleanup();
      resolve(null);
    }
  });
}

function getIframeViewportMetadata(iframe, lib) {
  const computedStyle = getComputedStyle(iframe);
  const radius = parseBorderRadius(computedStyle);
  const contentQuad = typeof lib.getElementQuad === 'function'
    ? lib.getElementQuad(iframe, 'content')
    : null;

  let quad;
  let transform;

  if (contentQuad) {
    const viewportWidth = iframe.clientWidth;
    const viewportHeight = iframe.clientHeight;
    if (viewportWidth <= 0 || viewportHeight <= 0) return null;

    quad = contentQuad;
    transform = {
      a: (quad[1].x - quad[0].x) / viewportWidth,
      b: (quad[1].y - quad[0].y) / viewportWidth,
      c: (quad[3].x - quad[0].x) / viewportHeight,
      d: (quad[3].y - quad[0].y) / viewportHeight,
      e: quad[0].x,
      f: quad[0].y,
    };
  } else {
    const viewportWidth = iframe.clientWidth;
    const viewportHeight = iframe.clientHeight;
    if (viewportWidth <= 0 || viewportHeight <= 0) return null;

    const rect = iframe.getBoundingClientRect();
    quad = rectToQuad(
      rect.left + iframe.clientLeft,
      rect.top + iframe.clientTop,
      viewportWidth,
      viewportHeight,
    );
    transform = {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: rect.left + iframe.clientLeft,
      f: rect.top + iframe.clientTop,
    };
  }

  return {
    transform,
    clipQuad: { points: quad, radius },
    clipBounds: isAxisAlignedQuad(quad)
      ? { ...getBoundsFromPoints(quad), radius }
      : undefined,
  };
}

function ensureFrameKeyResponder() {
  if (globalThis.__web2vectorFrameKeyResponderInstalled) return;

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== FRAME_KEY_REQUEST_MESSAGE || typeof data.token !== 'string') {
      return;
    }

    event.source?.postMessage({
      type: FRAME_KEY_RESPONSE_MESSAGE,
      token: data.token,
      frameKey: getFrameKey(),
    }, '*');
  });

  globalThis.__web2vectorFrameKeyResponderInstalled = true;
}

function getFrameKey() {
  if (!globalThis.__web2vectorFrameKey) {
    globalThis.__web2vectorFrameKey = createFrameToken();
  }

  return globalThis.__web2vectorFrameKey;
}

function createFrameToken() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseBorderRadius(style) {
  const borderRadius = style.borderRadius;
  if (!borderRadius || borderRadius === '0px') return 0;

  const parsed = parseFloat(borderRadius);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function rectToQuad(x, y, width, height) {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function isAxisAlignedQuad(quad) {
  const epsilon = 0.01;
  return (
    Math.abs(quad[0].y - quad[1].y) < epsilon &&
    Math.abs(quad[1].x - quad[2].x) < epsilon &&
    Math.abs(quad[2].y - quad[3].y) < epsilon &&
    Math.abs(quad[3].x - quad[0].x) < epsilon
  );
}

function getBoundsFromPoints(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

function getElementXPath(element) {
  const segments = [];
  let current = element;

  while (current) {
    segments.push(getXPathSegment(current));

    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }

    const root = current.getRootNode();
    if (root instanceof ShadowRoot) {
      segments.push('shadow-root()');
      current = root.host;
      continue;
    }

    current = null;
  }

  return `/${segments.reverse().join('/')}`;
}

function getXPathSegment(element) {
  const tagName = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) return tagName;

  let sameTagCount = 0;
  let sameTagIndex = 0;
  for (const sibling of Array.from(parent.children)) {
    if (sibling.tagName !== element.tagName) continue;
    sameTagCount += 1;
    if (sibling === element) {
      sameTagIndex = sameTagCount;
    }
  }

  return sameTagCount > 1 ? `${tagName}[${sameTagIndex}]` : tagName;
}