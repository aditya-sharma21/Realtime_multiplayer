import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeAcceptKey } from '../src/rfc6455.ts';

describe('RFC 6455 Protocol Handshake & Key Derivation', () => {
  test('matches RFC 6455 Section 4.2.2 standard test vector', () => {
    // Official test vector from RFC 6455 section 1.2
    const clientKey = 'dGhlIHNhbXBsZSBub25jZQ==';
    const expectedAccept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
    const calculated = computeAcceptKey(clientKey);
    assert.strictEqual(calculated, expectedAccept);
  });

  test('handles whitespace trimming in Sec-WebSocket-Key', () => {
    const clientKeyWithSpaces = '  dGhlIHNhbXBsZSBub25jZQ==  ';
    const expectedAccept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
    assert.strictEqual(computeAcceptKey(clientKeyWithSpaces), expectedAccept);
  });
});
