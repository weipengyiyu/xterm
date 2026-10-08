const assert = require('assert');
const {
  sendBinary, detachWsBackpressure, WS_MAX_QUEUE_ITEMS, WS_HIGH_WATER,
} = require('../server/ws-backpressure');

function mockWs() {
  return {
    readyState: 1,
    bufferedAmount: WS_HIGH_WATER + 1,
    sent: [],
    send(frame) { this.sent.push(Buffer.from(frame)); },
  };
}

const ws = mockWs();
const total = WS_MAX_QUEUE_ITEMS + 50;
for (let i = 0; i < total; i++) sendBinary(ws, 7, Buffer.from(`f${i}`));
assert.strictEqual(ws.sent.length, 0, 'a backed-up socket must not send');
assert.strictEqual(ws._outboundQueue.length, WS_MAX_QUEUE_ITEMS);
assert.strictEqual(ws._droppedFrames, 50);
assert.strictEqual(ws._outboundQueue[0].data.toString(), 'f50');
assert.strictEqual(ws._outboundQueue[WS_MAX_QUEUE_ITEMS - 1].data.toString(), `f${total - 1}`);
assert.strictEqual(ws._outboundQueue[0].id, 7);

ws.bufferedAmount = 0;
sendBinary(ws, 7, Buffer.from('tail'));
const payloads = ws.sent.map(frame => frame.subarray(2).toString());
assert.strictEqual(payloads[payloads.length - 1], 'tail', 'the newest frame must survive the flood');
assert.ok(!payloads.includes('f0'), 'the oldest flooded frame must be discarded');
assert.ok(payloads.includes(`f${total - 1}`), 'the frame just before the tail must still be delivered');

detachWsBackpressure(ws);
assert.strictEqual(ws._outboundTimer, null);
assert.strictEqual(ws._backpressureAttached, false);
assert.strictEqual(ws._outboundQueue.length, 0);

let liveTimers = 0;
for (let i = 0; i < 300; i++) {
  const client = mockWs();
  sendBinary(client, 1, Buffer.from('x'));
  detachWsBackpressure(client);
  if (client._outboundTimer) liveTimers++;
}
assert.strictEqual(liveTimers, 0, 'closing clients must not leave drain timers');

console.log(`✅ backpressure stress passed (${total} frames, tail kept, 300 attach/detach cycles)`);
