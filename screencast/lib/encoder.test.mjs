import { test } from 'node:test';
import assert from 'node:assert/strict';
import { H264, h264For } from './encoder.mjs';

test('macOS encodes H.264 in hardware, every other platform with libx264', () => {
  assert.equal(h264For('darwin'), 'h264_videotoolbox');
  assert.equal(h264For('linux'), 'libx264');
  assert.equal(h264For('win32'), 'libx264');
  assert.equal(H264, h264For(process.platform));
});
