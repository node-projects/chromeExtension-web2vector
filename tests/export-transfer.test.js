import { describe, expect, it } from 'vitest';

import { base64ToBytes } from '../src/shared/export-transfer.js';

describe('export transfer helpers', () => {
  it('decodes base64 payloads into byte arrays', () => {
    expect(Array.from(base64ToBytes('AQIDBA=='))).toEqual([1, 2, 3, 4]);
  });
});