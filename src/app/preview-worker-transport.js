// Registration and message ports belong to this transport, not project state.
// Resetting a failed connection also invalidates any older registration result.
function createPreviewWorkerTransport({ scriptUrl, scope, readyTimeout, messageTimeout }) {
  let worker = null;
  let pending = null;
  let generation = 0;

  const available = () => Boolean(window.isSecureContext && 'serviceWorker' in navigator &&
    (location.protocol === 'http:' || location.protocol === 'https:'));

  function reset() {
    generation += 1;
    worker?.dispose?.();
    worker = null;
    pending = null;
  }

  function waitForActivation(registration) {
    if (registration.active) return Promise.resolve(registration.active);
    const candidate = registration.installing || registration.waiting;
    if (!candidate) return Promise.resolve(null);
    return new Promise(resolve => {
      const finish = value => {
        clearTimeout(timer);
        candidate.removeEventListener('statechange', check);
        resolve(value);
      };
      const check = () => {
        if (candidate.state === 'activated') finish(registration.active || candidate);
        else if (candidate.state === 'redundant') finish(null);
      };
      const timer = setTimeout(() => finish(registration.active || null), readyTimeout);
      candidate.addEventListener('statechange', check);
      check();
    });
  }

  function ensure() {
    if (!available()) return Promise.resolve(null);
    if (worker?.state === 'activated') return Promise.resolve(worker);
    if (pending) return pending;
    worker = null;
    const currentGeneration = generation;
    const remote = new URL(scriptUrl).origin !== location.origin;
    const attempt = (remote ? connectRemote() : navigator.serviceWorker.register(scriptUrl, { scope, updateViaCache: 'none' }))
      .then(async registration => {
        if (remote) {
          if (generation !== currentGeneration) { registration.dispose(); return null; }
          worker = registration;
          return worker;
        }
        registration.update?.().catch(() => {});
        const candidate = await waitForActivation(registration);
        if (generation !== currentGeneration) return null;
        worker = candidate;
        return candidate;
      })
      .catch(error => { console.warn('Preview worker connection failed.', error); return null; })
      .finally(() => { if (pending === attempt) pending = null; });
    pending = attempt;
    return attempt;
  }

  function send(message, transfer = []) {
    return new Promise((resolve, reject) => {
      if (!worker) return reject(new Error('Service Worker no disponible'));
      const channel = new MessageChannel();
      const finish = (error, data) => {
        clearTimeout(timer);
        channel.port1.onmessage = null;
        channel.port1.onmessageerror = null;
        channel.port1.close();
        channel.port2.close();
        if (error) reject(error);
        else resolve(data);
      };
      const timer = setTimeout(() => finish(new Error('Timeout sincronizando preview')), messageTimeout);
      channel.port1.onmessage = event => {
        const data = event.data || {};
        finish(data.ok ? null : new Error(data.error || 'Error sincronizando preview'), data);
      };
      channel.port1.onmessageerror = () => finish(new Error('Respuesta de preview no válida'));
      try { worker.postMessage(message, [channel.port2, ...transfer]); }
      catch (error) { finish(error); }
    });
  }

  function cleanupLegacy() {
    if (!available()) return;
    if (new URL(scriptUrl).origin !== location.origin) return;
    navigator.serviceWorker.getRegistrations().then(registrations => {
      const expected = new URL(scriptUrl);
      const expectedScope = new URL(scope, location.href).href;
      for (const registration of registrations) {
        const candidate = registration.active || registration.waiting || registration.installing;
        if (!candidate) continue;
        const url = new URL(candidate.scriptURL);
        if (url.origin === expected.origin && url.pathname === expected.pathname && registration.scope !== expectedScope) {
          registration.unregister().catch(() => {});
        }
      }
    }).catch(() => {});
  }

  function connectRemote() {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      const url = new URL('preview-bridge.html', scriptUrl);
      url.searchParams.set('editor', location.origin);
      const channel = new MessageChannel();
      const dispose = () => { channel.port1.close(); frame.remove(); };
      const timer = setTimeout(() => { dispose(); reject(new Error('Preview origin unavailable')); }, Math.max(readyTimeout, 12000));
      channel.port1.onmessage = event => {
        clearTimeout(timer);
        channel.port1.onmessage = null;
        if (!event.data?.ok) { dispose(); reject(new Error(event.data?.error || 'Preview origin unavailable')); return; }
        resolve({ state: 'activated', dispose, postMessage: (data, transfer) => channel.port1.postMessage(data, transfer) });
      };
      frame.addEventListener('load', () => {
        frame.contentWindow.postMessage({ type: 'html-viewer:connect-preview', script: new URL(scriptUrl).pathname + new URL(scriptUrl).search }, url.origin, [channel.port2]);
      }, { once: true });
      frame.src = url.href;
      document.body.appendChild(frame);
    });
  }

  return { available, ensure, send, reset, cleanupLegacy };
}
