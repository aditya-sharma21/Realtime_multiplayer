import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Room } from '../src/room.ts';
import type { RawWebSocket } from '../src/rfc6455.ts';

// Mock minimal RawWebSocket for room logic unit testing
function createMockWebSocket() {
  const sentMessages: string[] = [];
  return {
    sentMessages,
    ws: {
      send: (data: string) => {
        sentMessages.push(data);
        return true;
      },
      close: () => {},
    } as unknown as RawWebSocket,
  };
}

describe('Room & Presence Management', () => {
  test('joins client, sends welcome snapshot, and notifies peers', () => {
    const room = new Room('test-room');

    const client1 = createMockWebSocket();
    room.addClient({
      clientId: 'c1',
      name: 'Alice',
      color: '#ff0000',
      ws: client1.ws,
      lastSeenSeq: 0,
      lastActiveTs: Date.now(),
      joinedAt: Date.now(),
    });

    assert.strictEqual(room.clientCount, 1);
    // Client 1 should receive welcome snapshot
    assert.strictEqual(client1.sentMessages.length, 1);
    const welcome = JSON.parse(client1.sentMessages[0]);
    assert.strictEqual(welcome.type, 'welcome');
    assert.strictEqual(welcome.roomState.roomId, 'test-room');
    assert.strictEqual(welcome.roomState.participants.length, 1);

    // Client 2 joins
    const client2 = createMockWebSocket();
    room.addClient({
      clientId: 'c2',
      name: 'Bob',
      color: '#00ff00',
      ws: client2.ws,
      lastSeenSeq: 0,
      lastActiveTs: Date.now(),
      joinedAt: Date.now(),
    });

    assert.strictEqual(room.clientCount, 2);
    // Client 1 should have received 'client_joined' for Bob
    assert.strictEqual(client1.sentMessages.length, 2);
    const joinedMsg = JSON.parse(client1.sentMessages[1]);
    assert.strictEqual(joinedMsg.type, 'client_joined');
    assert.strictEqual(joinedMsg.client.clientId, 'c2');
  });

  test('drops out-of-order stale cursor packets', () => {
    const room = new Room('test-room');
    const client1 = createMockWebSocket();
    const client2 = createMockWebSocket();

    room.addClient({
      clientId: 'c1',
      name: 'Alice',
      color: '#ff0000',
      ws: client1.ws,
      lastSeenSeq: 0,
      lastActiveTs: Date.now(),
      joinedAt: Date.now(),
    });
    room.addClient({
      clientId: 'c2',
      name: 'Bob',
      color: '#00ff00',
      ws: client2.ws,
      lastSeenSeq: 0,
      lastActiveTs: Date.now(),
      joinedAt: Date.now(),
    });

    // Clear initial messages
    client2.sentMessages.length = 0;

    // Send seq 5
    const acceptedSeq5 = room.handleCursor('c1', 5, Date.now(), 0.5, 0.5);
    assert.strictEqual(acceptedSeq5, true);
    assert.strictEqual(client2.sentMessages.length, 1);

    // Send seq 3 (arrived late over network) -> should be discarded!
    const acceptedSeq3 = room.handleCursor('c1', 3, Date.now(), 0.2, 0.2);
    assert.strictEqual(acceptedSeq3, false);
    // Client 2 should not have received the stale update
    assert.strictEqual(client2.sentMessages.length, 1);

    // Send seq 6 -> should be accepted
    const acceptedSeq6 = room.handleCursor('c1', 6, Date.now(), 0.6, 0.6);
    assert.strictEqual(acceptedSeq6, true);
    assert.strictEqual(client2.sentMessages.length, 2);
  });
});
