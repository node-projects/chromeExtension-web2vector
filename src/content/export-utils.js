export function createExportBlob(data, mime) {
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  return new Blob([bytes], { type: mime });
}

export function collectPotentiallyTaintedImageDiagnostics(irNodes, options = {}) {
  const normalizedOptions = getImageSourceOptions(options);

  return irNodes.flatMap((node) => {
    if (node?.type !== 'image') return [];
    if (isLikelyCanvasSafeImageSource(node.dataUrl, normalizedOptions)) return [];

    const classification = classifyCanvasImageSource(node.dataUrl, normalizedOptions);
    return [{
      source: node.dataUrl,
      resolvedUrl: classification.resolvedUrl,
      origin: classification.origin,
      pageOrigin: classification.pageOrigin,
      classification: classification.classification,
      sourceMetadata: node.source ?? null,
      originalType: node.source?.originalType ?? null,
      xpath: node.source?.xpath ?? null,
    }];
  });
}

export function collectInaccessibleIframeDiagnostics(root = globalThis.document) {
  const diagnostics = [];
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

      if (!isIframeElement(element)) continue;

      try {
        const frameDocument = element.contentDocument;
        if (!frameDocument) {
          diagnostics.push({
            src: normalizeOptionalString(element.src),
            title: normalizeOptionalString(element.title),
            reason: 'iframe-not-loaded',
            errorName: null,
          });
          continue;
        }

        visit(frameDocument);
      } catch (error) {
        diagnostics.push({
          src: normalizeOptionalString(element.src),
          title: normalizeOptionalString(element.title),
          reason: error?.name === 'SecurityError' ? 'cross-origin-iframe' : 'iframe-access-error',
          errorName: normalizeOptionalString(error?.name),
        });
      }
    }
  }

  visit(root);
  return diagnostics;
}

export function stripPotentiallyTaintedImages(irNodes, options = {}) {
  const { baseUrl, pageOrigin } = getImageSourceOptions(options);

  return irNodes.filter((node) => {
    if (node?.type !== 'image') return true;
    return isLikelyCanvasSafeImageSource(node.dataUrl, { baseUrl, pageOrigin });
  });
}

export async function replaceUnsafeImageSources(irNodes, resolver, options = {}) {
  if (typeof resolver !== 'function') return irNodes;

  const normalizedOptions = getImageSourceOptions(options);
  const unsafeSources = [...new Set(irNodes
    .filter((node) => node?.type === 'image')
    .map((node) => node.dataUrl)
    .filter((source) => !isLikelyCanvasSafeImageSource(source, normalizedOptions)))];

  if (unsafeSources.length === 0) return irNodes;

  const replacements = new Map();

  await Promise.all(unsafeSources.map(async (source) => {
    try {
      const resolvedSource = await resolver(source);
      if (typeof resolvedSource === 'string' && resolvedSource.startsWith('data:image/')) {
        replacements.set(source, resolvedSource);
      }
    } catch {
      // Ignore failures and fall back to the original URL.
    }
  }));

  if (replacements.size === 0) return irNodes;

  return irNodes.map((node) => {
    if (node?.type !== 'image') return node;
    const replacement = replacements.get(node.dataUrl);
    return replacement ? { ...node, dataUrl: replacement } : node;
  });
}

export function isLikelyCanvasSafeImageSource(source, options = {}) {
  const { classification } = classifyCanvasImageSource(source, options);
  return classification === 'data-url' ||
    classification === 'blob-url' ||
    classification === 'same-origin-url';
}

export function classifyCanvasImageSource(source, options = {}) {
  const normalizedOptions = getImageSourceOptions(options);

  if (typeof source !== 'string' || source.length === 0) {
    return {
      classification: 'missing-source',
      resolvedUrl: null,
      origin: null,
      pageOrigin: normalizedOptions.pageOrigin,
    };
  }

  if (source.startsWith('data:')) {
    return {
      classification: 'data-url',
      resolvedUrl: source,
      origin: null,
      pageOrigin: normalizedOptions.pageOrigin,
    };
  }

  if (source.startsWith('blob:')) {
    return {
      classification: 'blob-url',
      resolvedUrl: source,
      origin: null,
      pageOrigin: normalizedOptions.pageOrigin,
    };
  }

  const url = resolveImageSourceUrl(source, normalizedOptions.baseUrl);
  if (!url) {
    return {
      classification: 'invalid-url',
      resolvedUrl: null,
      origin: null,
      pageOrigin: normalizedOptions.pageOrigin,
    };
  }

  if (url.protocol === 'file:') {
    return {
      classification: 'file-url',
      resolvedUrl: url.href,
      origin: null,
      pageOrigin: normalizedOptions.pageOrigin,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      classification: 'other-url-scheme',
      resolvedUrl: url.href,
      origin: url.origin === 'null' ? null : url.origin,
      pageOrigin: normalizedOptions.pageOrigin,
    };
  }

  if (!normalizedOptions.pageOrigin) {
    return {
      classification: 'network-url-no-page-origin',
      resolvedUrl: url.href,
      origin: url.origin,
      pageOrigin: null,
    };
  }

  return {
    classification: url.origin === normalizedOptions.pageOrigin ? 'same-origin-url' : 'cross-origin-url',
    resolvedUrl: url.href,
    origin: url.origin,
    pageOrigin: normalizedOptions.pageOrigin,
  };
}

function getImageSourceOptions(options = {}) {
  return {
    baseUrl: options.baseUrl ?? globalThis.document?.baseURI ?? globalThis.location?.href,
    pageOrigin: options.pageOrigin ?? globalThis.location?.origin ?? null,
  };
}

function resolveImageSourceUrl(source, baseUrl) {
  try {
    return new URL(source, baseUrl);
  } catch {
    return null;
  }
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isIframeElement(element) {
  return typeof element?.tagName === 'string' && element.tagName.toLowerCase() === 'iframe';
}
