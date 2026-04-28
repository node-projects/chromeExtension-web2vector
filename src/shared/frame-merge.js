const IDENTITY_TRANSFORM = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function mergeFrameExtractionResults(frameResults, options = {}) {
  const normalizedResults = normalizeFrameResults(frameResults);
  if (normalizedResults.length === 0) return null;

  const rootFrameId = options.rootFrameId ?? 0;
  const rootFrame = normalizedResults.find((entry) => entry.frameId === rootFrameId) ?? normalizedResults[0];
  if (!rootFrame) return null;

  const frameMap = new Map(normalizedResults.map((entry) => [entry.frameKey, entry]));
  const mergedIr = mergeFrameTree(rootFrame.frameKey, frameMap, IDENTITY_TRANSFORM, [], new Set());

  return {
    rootFrameKey: rootFrame.frameKey,
    ir: mergedIr,
  };
}

function normalizeFrameResults(frameResults) {
  return (frameResults ?? [])
    .map((entry) => ({
      frameId: entry?.frameId ?? null,
      frameKey: entry?.result?.frameKey,
      ir: Array.isArray(entry?.result?.ir) ? entry.result.ir : [],
      childFrames: Array.isArray(entry?.result?.childFrames) ? entry.result.childFrames : [],
      paintOrder: Array.isArray(entry?.result?.paintOrder) ? entry.result.paintOrder : [],
    }))
    .filter((entry) => typeof entry.frameKey === 'string' && entry.frameKey.length > 0);
}

function mergeFrameTree(frameKey, frameMap, coordinateTransform, inheritedClipQuads, visitedFrameKeys) {
  if (visitedFrameKeys.has(frameKey)) return [];

  const frame = frameMap.get(frameKey);
  if (!frame) return [];

  visitedFrameKeys.add(frameKey);

  const mergedNodes = [];
  const consumedIndexes = new Set();
  const childFramesByAnchor = groupChildFramesByAnchor(frame.childFrames);

  for (const anchorXPath of frame.paintOrder) {
    appendNodesForAnchor(frame.ir, anchorXPath, consumedIndexes, coordinateTransform, inheritedClipQuads, mergedNodes);
    appendChildFrames(frameMap, childFramesByAnchor.get(anchorXPath), coordinateTransform, inheritedClipQuads, visitedFrameKeys, mergedNodes);
  }

  for (let index = 0; index < frame.ir.length; index += 1) {
    if (consumedIndexes.has(index)) continue;

    mergedNodes.push(transformIrNode(frame.ir[index], coordinateTransform, inheritedClipQuads));
  }

  return mergedNodes;
}

function groupChildFramesByAnchor(childFrames) {
  const grouped = new Map();

  for (const childFrame of childFrames) {
    const anchorXPath = childFrame?.anchorXPath;
    if (typeof anchorXPath !== 'string' || anchorXPath.length === 0) continue;

    const existing = grouped.get(anchorXPath) ?? [];
    existing.push(childFrame);
    grouped.set(anchorXPath, existing);
  }

  return grouped;
}

function appendNodesForAnchor(irNodes, anchorXPath, consumedIndexes, coordinateTransform, inheritedClipQuads, mergedNodes) {
  for (let index = 0; index < irNodes.length; index += 1) {
    if (consumedIndexes.has(index)) continue;

    const node = irNodes[index];
    if (node?.source?.xpath !== anchorXPath) continue;

    consumedIndexes.add(index);
    mergedNodes.push(transformIrNode(node, coordinateTransform, inheritedClipQuads));
  }
}

function appendChildFrames(frameMap, childFrames, coordinateTransform, inheritedClipQuads, visitedFrameKeys, mergedNodes) {
  if (!Array.isArray(childFrames) || childFrames.length === 0) return;

  for (const childFrame of childFrames) {
    const childFrameKey = childFrame?.childFrameKey;
    if (typeof childFrameKey !== 'string' || childFrameKey.length === 0) continue;

    const childTransform = composeCoordinateTransforms(coordinateTransform, childFrame.transform ?? IDENTITY_TRANSFORM);
    const childClipQuads = [...inheritedClipQuads];
    const transformedClipQuad = transformClipQuad(childFrame.clipQuad, coordinateTransform);

    if (transformedClipQuad) {
      childClipQuads.push(transformedClipQuad);
    }

    mergedNodes.push(...mergeFrameTree(childFrameKey, frameMap, childTransform, childClipQuads, visitedFrameKeys));
  }
}

function transformIrNode(node, coordinateTransform, inheritedClipQuads) {
  const nextNode = cloneValue(node);

  switch (nextNode.type) {
    case 'polygon':
    case 'polyline':
      nextNode.points = nextNode.points.map((point) => transformPoint(point, coordinateTransform));
      break;
    case 'text':
    case 'image':
      nextNode.quad = nextNode.quad.map((point) => transformPoint(point, coordinateTransform));
      break;
    default:
      break;
  }

  if (nextNode.style) {
    const localClipQuads = Array.isArray(nextNode.style.clipQuads)
      ? nextNode.style.clipQuads
        .map((clipQuad) => transformClipQuad(clipQuad, coordinateTransform))
        .filter(Boolean)
      : [];
    const mergedClipQuads = [
      ...inheritedClipQuads.map((clipQuad) => cloneValue(clipQuad)),
      ...localClipQuads,
    ];

    if (mergedClipQuads.length > 0) {
      nextNode.style.clipQuads = mergedClipQuads;
    } else {
      delete nextNode.style.clipQuads;
    }

    const transformedClipBounds = transformClipBounds(nextNode.style.clipBounds, coordinateTransform);
    if (transformedClipBounds) {
      nextNode.style.clipBounds = transformedClipBounds;
    } else {
      delete nextNode.style.clipBounds;
    }
  }

  return nextNode;
}

function composeCoordinateTransforms(parentTransform, childTransform) {
  return {
    a: parentTransform.a * childTransform.a + parentTransform.c * childTransform.b,
    b: parentTransform.b * childTransform.a + parentTransform.d * childTransform.b,
    c: parentTransform.a * childTransform.c + parentTransform.c * childTransform.d,
    d: parentTransform.b * childTransform.c + parentTransform.d * childTransform.d,
    e: parentTransform.a * childTransform.e + parentTransform.c * childTransform.f + parentTransform.e,
    f: parentTransform.b * childTransform.e + parentTransform.d * childTransform.f + parentTransform.f,
  };
}

function transformPoint(point, coordinateTransform) {
  return {
    x: coordinateTransform.a * point.x + coordinateTransform.c * point.y + coordinateTransform.e,
    y: coordinateTransform.b * point.x + coordinateTransform.d * point.y + coordinateTransform.f,
  };
}

function transformClipQuad(clipQuad, coordinateTransform) {
  if (!clipQuad || !Array.isArray(clipQuad.points)) return null;

  return {
    ...clipQuad,
    points: clipQuad.points.map((point) => transformPoint(point, coordinateTransform)),
  };
}

function transformClipBounds(clipBounds, coordinateTransform) {
  if (!clipBounds) return null;

  const transformedQuad = rectToQuad(clipBounds.x, clipBounds.y, clipBounds.w, clipBounds.h)
    .map((point) => transformPoint(point, coordinateTransform));

  if (!isAxisAlignedQuad(transformedQuad)) return null;

  const bounds = getBoundsFromPoints(transformedQuad);
  return {
    ...bounds,
    radius: clipBounds.radius,
  };
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

function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}