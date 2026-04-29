function coerceByte(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number <= 0) return 0;
  if (number >= 255) return 255;
  return Math.trunc(number);
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value, coerceByte);
  }

  if (value && typeof value === 'object') {
    if (Array.isArray(value.data)) {
      return Uint8Array.from(value.data, coerceByte);
    }

    const numericKeys = Object.keys(value)
      .filter((key) => /^\d+$/.test(key))
      .sort((left, right) => Number(left) - Number(right));

    if (numericKeys.length > 0) {
      return Uint8Array.from(numericKeys.map((key) => coerceByte(value[key])));
    }
  }

  return null;
}

function toTransferableByteArray(value) {
  const bytes = toUint8Array(value);
  return bytes ? Array.from(bytes) : null;
}

export function serializeFontAssetsForTransfer(fontAssets) {
  if (!fontAssets || !Array.isArray(fontAssets.faces) || fontAssets.faces.length === 0) {
    return undefined;
  }

  const faces = fontAssets.faces
    .map((face) => {
      const sources = Array.isArray(face?.sources)
        ? face.sources
          .map((source) => {
            const data = toTransferableByteArray(source?.data);
            if (!data) return null;

            return {
              ...source,
              data,
            };
          })
          .filter(Boolean)
        : [];

      if (sources.length === 0) {
        return null;
      }

      return {
        ...face,
        sources,
      };
    })
    .filter(Boolean);

  return faces.length > 0 ? { faces } : undefined;
}

export function normalizeTransferredFontAssets(fontAssets) {
  if (!fontAssets || !Array.isArray(fontAssets.faces) || fontAssets.faces.length === 0) {
    return undefined;
  }

  const faces = fontAssets.faces
    .map((face) => {
      const sources = Array.isArray(face?.sources)
        ? face.sources
          .map((source) => {
            const data = toUint8Array(source?.data);
            if (!data) return null;

            return {
              ...source,
              data,
            };
          })
          .filter(Boolean)
        : [];

      if (sources.length === 0) {
        return null;
      }

      return {
        ...face,
        sources,
      };
    })
    .filter(Boolean);

  return faces.length > 0 ? { faces } : undefined;
}