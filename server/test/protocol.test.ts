import { test, describe } from 'node:test';
import assert from 'node:assert';
import { validateClientMessage } from '../src/protocol.ts';

describe('Protocol Message Validation', () => {
  test('validates and accepts well-formed join message', () => {
    const raw = {
      type: 'join',
      roomId: 'watch-party-42',
      clientId: 'user_abc',
      name: 'Aditya',
      color: '#ff4444',
    };
    const res = validateClientMessage(raw);
    assert.strictEqual(res.valid, true);
    if (res.valid) {
      assert.strictEqual(res.message.type, 'join');
      assert.strictEqual(res.message.roomId, 'watch-party-42');
      assert.strictEqual(res.message.clientId, 'user_abc');
    }
  });

  test('validates and clamps normalized cursor coordinates [0, 1]', () => {
    const raw = {
      type: 'cursor',
      seq: 14,
      ts: 1700000000000,
      x: 1.25, // out of range: should clamp to 1.0
      y: -0.15, // out of range: should clamp to 0.0
    };
    const res = validateClientMessage(raw);
    assert.strictEqual(res.valid, true);
    if (res.valid && res.message.type === 'cursor') {
      assert.strictEqual(res.message.x, 1.0);
      assert.strictEqual(res.message.y, 0.0);
      assert.strictEqual(res.message.seq, 14);
    }
  });

  test('rejects malformed messages without crashing', () => {
    assert.strictEqual(validateClientMessage(null).valid, false);
    assert.strictEqual(validateClientMessage('not an object').valid, false);
    assert.strictEqual(validateClientMessage({ type: 'unknown_type' }).valid, false);
    assert.strictEqual(validateClientMessage({ type: 'cursor', x: 'invalid', y: 1 }).valid, false);
    assert.strictEqual(validateClientMessage({ type: 'join', roomId: '', clientId: 'a' }).valid, false);
  });
});
