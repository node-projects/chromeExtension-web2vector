export function createExportBlob(data, mime) {
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  return new Blob([bytes], { type: mime });
}

export function stripPotentiallyTaintedImages(irNodes, options = {}) {
  const baseUrl = options.baseUrl ?? globalThis.document?.baseURI ?? globalThis.location?.href;
  const pageOrigin = options.pageOrigin ?? globalThis.location?.origin ?? null;

  return irNodes.filter((node) => {
    if (node?.type !== 'image') return true;
    return isLikelyCanvasSafeImageSource(node.dataUrl, { baseUrl, pageOrigin });
  });
}

export function isLikelyCanvasSafeImageSource(source, options = {}) {
  if (typeof source !== 'string' || source.length === 0) return false;
  if (source.startsWith('data:') || source.startsWith('blob:')) return true;

  try {
    const url = new URL(source, options.baseUrl);
    if (!options.pageOrigin) return false;
    return url.origin === options.pageOrigin;
  } catch {
    return false;
  }
}
