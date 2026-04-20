function getQuadPoints(rawQuad) {
  if (!rawQuad) return [];
  if (Array.isArray(rawQuad)) return rawQuad;
  return [rawQuad.p1, rawQuad.p2, rawQuad.p3, rawQuad.p4].filter(Boolean);
}

function getIrNodePoints(node) {
  if (node.type === 'polygon' || node.type === 'polyline') {
    return node.points ?? [];
  }

  if (node.type === 'text' || node.type === 'image') {
    return node.quad ?? [];
  }

  return [];
}

function getRootQuads(root) {
  if (!('getBoxQuads' in root) || typeof root.getBoxQuads !== 'function') {
    return [];
  }

  try {
    return root.getBoxQuads({ box: 'border' });
  } catch {
    return [];
  }
}

export function getViewportSizeFromMetrics({
  quads = [],
  rect = { width: 0, height: 0 },
  scrollWidth = 0,
  scrollHeight = 0,
  clientWidth = 0,
  clientHeight = 0,
}) {
  if (quads.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const quad of quads) {
      for (const point of getQuadPoints(quad)) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
    }

    if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
      return {
        width: Math.ceil(Math.max(maxX - minX, scrollWidth, clientWidth)) || 1,
        height: Math.ceil(Math.max(maxY - minY, scrollHeight, clientHeight)) || 1,
      };
    }
  }

  return {
    width: Math.ceil(Math.max(rect.width ?? 0, scrollWidth, clientWidth)) || 1,
    height: Math.ceil(Math.max(rect.height ?? 0, scrollHeight, clientHeight)) || 1,
  };
}

export function getIrExtent(irNodes) {
  let maxX = 0;
  let maxY = 0;

  for (const node of irNodes ?? []) {
    for (const point of getIrNodePoints(node)) {
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }

  return { maxX, maxY };
}

export function applyIrExtentFallback(viewport, irNodes) {
  const nextViewport = { ...viewport };
  const { maxX, maxY } = getIrExtent(irNodes);

  if (nextViewport.width <= 1 && maxX > 0) nextViewport.width = Math.ceil(maxX);
  if (nextViewport.height <= 1 && maxY > 0) nextViewport.height = Math.ceil(maxY);

  return nextViewport;
}

export function calculateExportSize(root, irNodes) {
  return applyIrExtentFallback(
    getViewportSizeFromMetrics({
      quads: getRootQuads(root),
      rect: root.getBoundingClientRect(),
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
    }),
    irNodes,
  );
}