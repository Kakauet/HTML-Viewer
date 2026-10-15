const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function setup(register, MessageChannel = globalThis.MessageChannel) {
  const factory = vm.runInNewContext(readFileSync(require.resolve('../src/app/preview-worker-transport.js'), 'utf8') + '\ncreatePreviewWorkerTransport;', {
    window: { isSecureContext: true }, navigator: { serviceWorker: { register } },
    location: new URL('https://viewer.test/'), URL, setTimeout, clearTimeout, MessageChannel
  });
  return factory({ scriptUrl: 'https://viewer.test/preview-sw.js', scope: '/__html_viewer_project__/', readyTimeout: 25, messageTimeout: 25 });
}

test('concurrent callers share activation and a reset cannot restore a stale worker', async () => {
  let registrations = 0;
  const resolvers = [];
  const transport = setup(() => { registrations++; return new Promise(resolve => resolvers.push(resolve)); });
  const first = transport.ensure();
  assert.equal(transport.ensure(), first);
  assert.equal(registrations, 1);
  transport.reset();
  const next = transport.ensure();
  const oldWorker = { state: 'activated' }, newWorker = { state: 'activated' };
  resolvers[1]({ active: newWorker });
  assert.equal(await next, newWorker);
  resolvers[0]({ active: oldWorker });
  assert.equal(await first, null);
  assert.equal(await transport.ensure(), newWorker);
});

test('activation timeout removes listeners and permits a subsequent retry', async () => {
  const candidate = new EventTarget();
  candidate.state = 'installing';
  let listeners = 0, registrations = 0;
  const add = candidate.addEventListener.bind(candidate), remove = candidate.removeEventListener.bind(candidate);
  candidate.addEventListener = (...args) => { listeners++; add(...args); };
  candidate.removeEventListener = (...args) => { listeners--; remove(...args); };
  const transport = setup(async () => { registrations++; return { installing: candidate }; });
  assert.equal(await transport.ensure(), null);
  assert.equal(listeners, 0);
  candidate.state = 'activated';
  assert.equal(await transport.ensure(), candidate);
  assert.equal(registrations, 2);
  assert.equal(listeners, 0);
});

test('message ports close after postMessage errors, unreadable replies and timeouts', async () => {
  const channels = [];
  class Channel {
    constructor() {
      const port = () => ({ closed: false, close() { this.closed = true; } });
      this.port1 = port(); this.port2 = port(); channels.push(this);
    }
  }
  const worker = { state: 'activated', postMessage() { throw new Error('clone failed'); } };
  const transport = setup(async () => ({ active: worker }), Channel);
  await transport.ensure();
  await assert.rejects(transport.send({}), /clone failed/);
  worker.postMessage = () => queueMicrotask(() => channels.at(-1).port1.onmessageerror());
  await assert.rejects(transport.send({}), /no válida/);
  worker.postMessage = () => {};
  await assert.rejects(transport.send({}), /Timeout/);
  assert.ok(channels.every(channel => channel.port1.closed && channel.port2.closed && channel.port1.onmessage === null));
});
