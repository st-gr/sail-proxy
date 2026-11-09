import { describe, it, expect } from '@jest/globals';
import { chunkText } from '../src/controllers/openaiController';

describe('chunkText break points (#7)', () => {
  it('treats whitespace as a break char (was matching literal s/backslash)', () => {
    // Words of 5 chars separated by single spaces. With the buggy \\s regex,
    // spaces are NOT boundaries, so no chunk ends on a space; with the fixed
    // \s regex, the look-back finds the space and breaks there.
    const input = 'aaaaa bbbbb ccccc ddddd';
    const chunks = chunkText(input, 3);
    expect(chunks.join('')).toBe(input);                       // lossless
    expect(chunks.slice(0, -1).some(c => c.endsWith(' '))).toBe(true); // a non-last chunk ends on a whitespace boundary
  });
});
