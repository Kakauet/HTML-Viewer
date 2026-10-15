const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { browserType, browserName } = require('./browser.cjs');

const workspaceRoot = path.resolve(__dirname, '..');
const externalBaseUrl = process.env.PREVIEW_BASE_URL || '';
const port = Number(process.env.PREVIEW_TEST_PORT || 4173);
// Use the actual Spanish app, independent of the host/browser language.
const baseUrl = externalBaseUrl || `http://127.0.0.1:${port}/es/`;

let browser;
let serverProcess;

function waitForServer(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, response => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      request.on('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`El servidor de prueba no respondió en ${url}`));
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

async function waitForMonaco(page) {
  await page.waitForFunction(() => typeof monacoLoaded !== 'undefined' && monacoLoaded);
  const input = page.locator('.monaco-editor textarea.inputarea');
  await input.waitFor({ state: 'attached', timeout: 15000 });
  return input;
}

// Seed fixtures through Monaco's API; keyboard behaviour has dedicated UI tests.
async function setEditorValue(page, value) {
  await waitForMonaco(page);
  await page.evaluate(value => editor.setValue(value), value);
}

async function setAvailableEditorValue(page, value) {
  await page.evaluate(value => {
    if (monacoLoaded) editor.setValue(value);
    else {
      fallbackTextarea.value = value;
      fallbackTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, value);
}

async function getPreviewFrameUrl(page) {
  return page.locator('#preview-iframe').evaluate(iframe => {
    try { return iframe.contentWindow.location.href; }
    catch { return iframe.src; }
  });
}

async function waitForPreviewFrameLocation(page, predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const frame = page.frames().find(item => item.parentFrame() === page.mainFrame());
    if (frame && predicate(frame.url())) return frame.url();
    await page.waitForTimeout(50);
  }
  assert.fail('La URL del iframe no cumplio la condicion: ' + page.frames().map(item => item.url()).join(', '));
}

// A previewed page shows its published URL (`/page`); the runtime exposes
// which session and worker URL it was loaded from.
async function getPreviewRuntimeInfo(page) {
  const frame = page.frames().find(item => item.parentFrame() === page.mainFrame());
  return frame ? frame.evaluate(() => window.__htmlViewerPreview || null).catch(() => null) : null;
}

async function waitForPreviewSourceChange(page, previousHref, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const info = await getPreviewRuntimeInfo(page);
    if (info?.sourceHref && info.sourceHref !== previousHref) return info;
    await page.waitForTimeout(50);
  }
  assert.fail('La previsualizacion no cargo una nueva version de ' + previousHref);
}

async function openProjectFile(page, filename) {
  await page.locator('.file-item').filter({ hasText: filename }).first().click();
  await page.waitForTimeout(350);
}

async function countStoredPreviewSessions(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('html-viewer-preview-sessions', 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('sessions')) {
        request.result.createObjectStore('sessions', { keyPath: 'sessionId' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('sessions', 'readonly');
      const countRequest = transaction.objectStore('sessions').count();
      countRequest.onsuccess = () => {
        resolve(countRequest.result);
        database.close();
      };
      countRequest.onerror = () => {
        reject(countRequest.error);
        database.close();
      };
    };
  }));
}

async function expireStoredPreviewSession(page, sessionId) {
  await page.evaluate(targetSessionId => new Promise((resolve, reject) => {
    const request = indexedDB.open('html-viewer-preview-sessions', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('sessions', 'readwrite');
      const store = transaction.objectStore('sessions');
      const getRequest = store.get(targetSessionId);
      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => {
        const record = getRequest.result;
        if (!record) {
          reject(new Error(`No existe la sesión persistida ${targetSessionId}`));
          return;
        }
        record.updatedAt = Date.now() - (8 * 24 * 60 * 60 * 1000);
        store.put(record);
      };
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error);
      };
    };
  }), sessionId);
}

function projectIndexHtml(version) {
  return `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1 id="version">${version}</h1><a id="to-second" href="page.html">Ir a segunda</a><img id="nested-image" src="assets/nested/mark.svg" alt="Marca"><span id="script-status"></span><script src="script.js"></script></body></html>`;
}

function projectSecondHtml(version) {
  return `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1 id="version">${version}</h1><a id="to-home" href="index.html">Volver</a><img id="nested-image" src="assets/nested/mark.svg" alt="Marca"><span id="script-status"></span><script src="script.js"></script></body></html>`;
}

async function waitForPreviewVersion(page, expected, timeoutMs = 8000) {
  const marker = page.frameLocator('#preview-iframe').locator('#version');
  const startedAt = Date.now();
  let actual = '';
  while (Date.now() - startedAt < timeoutMs) {
    actual = await marker.textContent({ timeout: 500 }).catch(() => '');
    if (actual === expected) return;
    await page.waitForTimeout(50);
  }
  const frameState = await page.locator('#preview-iframe').evaluate(iframe => {
    try {
      return { url: iframe.contentWindow.location.href, body: iframe.contentDocument?.body?.innerText || '' };
    } catch {
      return { url: iframe.src, body: '' };
    }
  });
  assert.equal(actual, expected, `Estado final del iframe: ${JSON.stringify(frameState)}`);
}

async function createSecondPageProject(page) {
  await setEditorValue(page, '<!doctype html><html><body><h1 id="version">HOME</h1><a id="to-second" href="page.html">Ir a segunda</a></body></html>');
  await page.getByRole('button', { name: 'Archivos', exact: true }).click();
  await waitForPreviewVersion(page, 'HOME');
  await page.waitForTimeout(200);
  await page.locator('#btn-new-file').click();
  const renameInput = page.locator('.file-rename-input');
  await renameInput.waitFor({ state: 'visible' });
  await renameInput.fill('page.html');
  await renameInput.press('Enter');
  await setEditorValue(page, '<!doctype html><html><body><h1 id="version">SECOND</h1><a href="index.html">Volver</a></body></html>');

  await page.locator('.file-item').filter({ hasText: 'index.html' }).first().click();
  await page.waitForTimeout(350);
  await setEditorValue(page, '<!doctype html><html><body><h1 id="version">HOME</h1><a id="to-second" href="page.html">Ir a segunda</a></body></html>');
  await waitForPreviewVersion(page, 'HOME');
}

async function addNestedProjectAssets(page) {
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const root = getProjectRootFolder();
    const records = [
      createFolderRecord(`${root}assets/`),
      createFolderRecord(`${root}assets/nested/`),
      createTextFileRecord(
        `${root}assets/nested/mark.svg`,
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#6d28d9"/></svg>'
      )
    ];
    for (const record of records) {
      if (!files.some(file => file.name.toLowerCase() === record.name.toLowerCase())) files.push(record);
    }
    normalizeProjectFiles();
    markProjectPreviewDirty(null, { all: true });
    renderFileExplorer();
    updatePreview();
  });
  await page.waitForTimeout(250);

  await openProjectFile(page, 'styles.css');
  await setEditorValue(page, 'body{background:rgb(244,247,252);font-family:system-ui}#nested-image{width:32px;height:32px}');
  await openProjectFile(page, 'script.js');
  await setEditorValue(page, 'document.body.dataset.fixtureReady="true";document.querySelector("#script-status").textContent="JS-READY";');
  await openProjectFile(page, 'page.html');
  await setEditorValue(page, projectSecondHtml('SECOND'));
  await openProjectFile(page, 'index.html');
  await setEditorValue(page, projectIndexHtml('HOME'));
  await waitForPreviewVersion(page, 'HOME');
  await page.frameLocator('#preview-iframe').locator('#nested-image').waitFor({ state: 'visible', timeout: 10000 });
  await page.frameLocator('#preview-iframe').locator('#script-status').filter({ hasText: 'JS-READY' }).waitFor({ state: 'visible', timeout: 10000 });
}

before(async () => {
  if (!externalBaseUrl) {
    serverProcess = spawn(process.execPath, ['scripts/local-server.cjs', String(port)], {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    serverProcess.stderr.on('data', chunk => process.stderr.write(chunk));
    await Promise.race([
      waitForServer(baseUrl),
      once(serverProcess, 'exit').then(([code]) => {
        throw new Error(`El servidor de prueba terminó antes de tiempo (${code})`);
      })
    ]);
  }
  browser = await browserType.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await once(serverProcess, 'exit').catch(() => {});
  }
});

test('mantiene la página navegada al editarla y conserva un solo iframe', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await createSecondPageProject(page);

  await page.frameLocator('#preview-iframe').locator('#to-second').click();
  await waitForPreviewVersion(page, 'SECOND');

  await page.locator('.file-item').filter({ hasText: 'page.html' }).first().click();
  await page.waitForTimeout(350);
  await setEditorValue(page, '<!doctype html><html><body><h1 id="version">SECOND-LATEST</h1><a href="index.html">Volver</a></body></html>');
  await waitForPreviewVersion(page, 'SECOND-LATEST');

  assert.equal(await page.locator('#preview-iframe').count(), 1);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('acciones rápidas comparten una sola generación y una sola transición visible', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__delayNextProjectMessage = false;
    if ('ServiceWorker' in window) {
      const originalPostMessage = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message, transfer) {
        if (window.__delayNextProjectMessage && message?.type === 'html-viewer:set-project') {
          window.__delayNextProjectMessage = false;
          const worker = this;
          setTimeout(() => originalPostMessage.call(worker, message, transfer), 250);
          return;
        }
        return originalPostMessage.call(this, message, transfer);
      };
    }
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await createSecondPageProject(page);
  await page.frameLocator('#preview-iframe').locator('#to-second').click();
  await waitForPreviewVersion(page, 'SECOND');
  await openProjectFile(page, 'page.html');

  await page.evaluate(() => { window.__delayNextProjectMessage = true; });
  await setEditorValue(page, '<!doctype html><h1 id="version">RAPID-OLD</h1>');
  await setEditorValue(page, '<!doctype html><h1 id="version">RAPID-MIDDLE</h1>');
  await setEditorValue(page, '<!doctype html><h1 id="version">RAPID-LATEST</h1>');
  await waitForPreviewVersion(page, 'RAPID-LATEST');
  await page.waitForTimeout(350);
  assert.equal(await page.frameLocator('#preview-iframe').locator('#version').textContent(), 'RAPID-LATEST');

  await page.evaluate(() => {
    for (let index = 0; index < 12; index += 1) triggerPreviewReload();
  });
  await waitForPreviewVersion(page, 'RAPID-LATEST');
  await page.waitForFunction(() => previewLifecycle.phase === 'idle' && !previewLifecycle.expectedNavigation);

  await page.evaluate(() => {
    for (let index = 0; index < 12; index += 1) returnPreviewToHome();
  });
  await waitForPreviewVersion(page, 'HOME');
  const lifecycleState = await page.evaluate(() => ({
    iframeCount: document.querySelectorAll('#preview-iframe').length,
    generation: previewLifecycle.generation,
    committedGeneration: previewLifecycle.committedGeneration,
    phase: previewLifecycle.phase,
    scheduled: previewLifecycle.scheduledRequest,
    expected: previewLifecycle.expectedNavigation,
    path: previewLifecycle.projectPath
  }));
  assert.equal(lifecycleState.iframeCount, 1);
  assert.equal(lifecycleState.generation, lifecycleState.committedGeneration);
  assert.equal(lifecycleState.phase, 'idle');
  assert.equal(lifecycleState.scheduled, null);
  assert.equal(lifecycleState.expected, null);
  assert.match(lifecycleState.path, /index\.html$/);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('Simple preserves native APIs, focus, forms, popups and document.write', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const compatibilityHtml = `<!doctype html><html><body>
    <input id="interactive" autofocus>
    <button id="popup" onclick="window.open('about:blank#popup', '_blank')">Popup</button>
    <form id="form" action="about:blank" method="get"><input name="sent" value="yes"><button id="submit">Enviar</button></form>
    <x-compatible id="custom"></x-compatible>
    <script>
      customElements.define('x-compatible', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<strong id="shadow-value">SHADOW-READY</strong>'; }
      });
      document.body.dataset.nativeFetch = String(fetch).includes('[native code]');
      document.body.dataset.nativeXhr = String(XMLHttpRequest.prototype.open).includes('[native code]');
    </script>
  </body></html>`;
  await setEditorValue(page, compatibilityHtml);
  const input = page.frameLocator('#preview-iframe').locator('#interactive');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.click();
  await input.type('INTERACTIVE');
  assert.equal(await input.inputValue(), 'INTERACTIVE');

  const compatibilityState = await page.frameLocator('#preview-iframe').locator('body').evaluate(body => ({
    nativeFetch: body.dataset.nativeFetch,
    nativeXhr: body.dataset.nativeXhr,
    focusGuard: body.ownerDocument.documentElement.hasAttribute('data-html-viewer-embedded-preview'),
    shadow: body.querySelector('#custom')?.shadowRoot?.querySelector('#shadow-value')?.textContent
  }));
  assert.deepEqual(compatibilityState, {
    nativeFetch: 'true',
    nativeXhr: 'true',
    focusGuard: false,
    shadow: 'SHADOW-READY'
  });

  const popupPromise = page.waitForEvent('popup');
  await page.frameLocator('#preview-iframe').locator('#popup').click();
  const popup = await popupPromise;
  assert.match(popup.url(), /^about:blank/);
  await popup.close();

  await page.frameLocator('#preview-iframe').locator('#submit').click();
  // Simple documents are sandboxed without the editor's origin: the frame's
  // location is only visible from outside the page.
  await waitForPreviewFrameLocation(page, url => url.includes('sent=yes'));
  await page.getByRole('button', { name: /Volver a la p.gina inicial/ }).click();
  await input.waitFor({ state: 'visible', timeout: 10000 });

  await setEditorValue(page, `<!doctype html><script>
    document.open();
    document.write('<h1 id="version">DOCUMENT-WRITE</h1><a id="away" href="about:blank#away">Salir</a>');
    document.close();
  <\/script>`);
  await waitForPreviewVersion(page, 'DOCUMENT-WRITE');
  await page.frameLocator('#preview-iframe').locator('#away').click();
  await page.waitForFunction(() => !document.querySelector('#btn-preview-home').disabled);

  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('Simple coalesces a burst without debounce to one render per frame', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitForMonaco(page);

  await page.evaluate(() => {
    const iframe = document.querySelector('#preview-iframe');
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
    window.__srcdocAssignments = 0;
    Object.defineProperty(iframe, 'srcdoc', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        window.__srcdocAssignments += 1;
        return descriptor.set.call(this, value);
      }
    });
    for (let index = 0; index < 80; index += 1) {
      unifiedModel.setValue(`<!doctype html><h1 id="version">FRAME-${index}</h1>`);
    }
  });
  await waitForPreviewVersion(page, 'FRAME-79');
  const assignments = await page.evaluate(() => window.__srcdocAssignments);
  assert.ok(assignments <= 2, `Se hicieron ${assignments} asignaciones de srcdoc`);
  await page.close();
});

test('Files supports root paths, base, ES modules, fetch and internal GET forms', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await setEditorValue(page, '<!doctype html><h1>BOOT</h1>');
  await page.getByRole('button', { name: 'Archivos', exact: true }).click();

  await page.evaluate(() => {
    const root = getProjectRootFolder();
    const index = getEntryFile();
    const indexContent = `<!doctype html><html><head>
      <base href="/">
      <link rel="stylesheet" href="/assets/styles.css">
    </head><body>
      <h1 id="version">FILES-COMPAT</h1>
      <a id="root-link" href="/nested/page.html?v=user">Nested</a>
      <button id="spa-route" onclick="history.pushState({}, '', '/dashboard');document.querySelector('#version').textContent='FILES-SPA'">SPA</button>
      <button id="spa-replace" onclick="history.replaceState({}, '', '/settings?mode=replace');document.querySelector('#version').textContent='FILES-REPLACE'">Replace</button>
      <button id="spa-hash" onclick="location.hash='section';document.querySelector('#version').textContent='FILES-HASH'">Hash</button>
      <output id="history-events"></output>
      <form id="search-form" action="/nested/page.html" method="get">
        <input name="from" value="form"><button id="form-submit">Enviar</button>
      </form>
      <output id="module-status"></output>
      <script>
        addEventListener('popstate', () => document.querySelector('#history-events').textContent += 'popstate;');
        addEventListener('hashchange', () => document.querySelector('#history-events').textContent += 'hashchange;');
      </script>
      <script type="module" src="/assets/main.mjs"></script>
    </body></html>`;
    window.__compatIndexContent = indexContent;
    index.content = indexContent;
    index.size = new Blob([indexContent]).size;
    if (fileModels[index.id]) fileModels[index.id].setValue(indexContent);
    const additions = [
      createFolderRecord(`${root}assets/`),
      createFolderRecord(`${root}nested/`),
      createTextFileRecord(`${root}assets/styles.css`, 'body{--compat-color:rgb(12, 34, 56)}'),
      createTextFileRecord(`${root}assets/dep.mjs`, 'export const dependency = "IMPORT-READY";'),
      createTextFileRecord(`${root}assets/main.mjs`, `
        import { dependency } from './dep.mjs';
        const data = await fetch('/data.json').then(response => response.json());
        document.querySelector('#module-status').textContent = dependency + ':' + data.value;
      `),
      createTextFileRecord(`${root}data.json`, '{"value":"FETCH-READY"}'),
      createTextFileRecord(`${root}nested/page.html`, '<!doctype html><h1 id="version">NESTED-READY</h1><a href="/">Inicio</a>')
    ];
    for (const record of additions) {
      if (!files.some(file => file.name.toLowerCase() === record.name.toLowerCase())) files.push(record);
    }
    normalizeProjectFiles();
    markProjectPreviewDirty(null, { all: true });
    renderFileExplorer();
    updatePreview();
  });

  await waitForPreviewVersion(page, 'FILES-COMPAT');
  await page.frameLocator('#preview-iframe').locator('#module-status').filter({ hasText: 'IMPORT-READY:FETCH-READY' }).waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(
    await page.frameLocator('#preview-iframe').locator('body').evaluate(body => getComputedStyle(body).getPropertyValue('--compat-color').trim()),
    'rgb(12, 34, 56)'
  );

  const responseCompatibility = await page.frameLocator('#preview-iframe').locator('body').evaluate(async () => {
    const head = await fetch('/assets/styles.css', { method: 'HEAD' });
    const range = await fetch('/assets/styles.css', { headers: { Range: 'bytes=0-3' } });
    const missing = await fetch('./missing.bin');
    return {
      headStatus: head.status,
      headType: head.headers.get('content-type'),
      headLength: Number(head.headers.get('content-length')),
      rangeStatus: range.status,
      rangeValue: await range.text(),
      rangeHeader: range.headers.get('content-range'),
      missingStatus: missing.status
    };
  });
  assert.equal(responseCompatibility.headStatus, 200);
  assert.match(responseCompatibility.headType, /^text\/css/);
  assert.ok(responseCompatibility.headLength > 4);
  assert.equal(responseCompatibility.rangeStatus, 206);
  assert.equal(responseCompatibility.rangeValue, 'body');
  assert.match(responseCompatibility.rangeHeader, /^bytes 0-3\//);
  assert.equal(responseCompatibility.missingStatus, 404);

  await page.frameLocator('#preview-iframe').locator('#spa-route').click();
  await waitForPreviewVersion(page, 'FILES-SPA');
  await page.frameLocator('#preview-iframe').locator('#spa-replace').click();
  await waitForPreviewVersion(page, 'FILES-REPLACE');
  await page.frameLocator('#preview-iframe').locator('#spa-hash').click();
  await waitForPreviewVersion(page, 'FILES-HASH');
  await page.frameLocator('#preview-iframe').locator('#history-events').filter({ hasText: 'hashchange;' }).waitFor({ state: 'visible' });
  const mainUrlBeforeBrowserBack = page.url();
  await page.evaluate(() => history.back());
  await waitForPreviewFrameLocation(page, url => !new URL(url).hash);
  await page.frameLocator('#preview-iframe').locator('#history-events').filter({ hasText: 'popstate;' }).waitFor({ state: 'visible' });
  assert.equal(page.url(), mainUrlBeforeBrowserBack);
  await page.evaluate(() => history.back());
  await waitForPreviewFrameLocation(page, url => new URL(url).pathname === '/');
  assert.equal(page.url(), mainUrlBeforeBrowserBack);
  assert.equal(await page.locator('#preview-iframe').count(), 1);

  await page.frameLocator('#preview-iframe').locator('#spa-route').click();
  await waitForPreviewVersion(page, 'FILES-SPA');
  await page.evaluate(() => {
    const index = getEntryFile();
    fileModels[index.id].setValue(window.__compatIndexContent.replace('FILES-COMPAT', 'FILES-SPA-LATEST'));
  });
  await waitForPreviewVersion(page, 'FILES-SPA-LATEST');
  const spaUrl = await getPreviewFrameUrl(page);
  assert.equal(new URL(spaUrl).pathname, '/dashboard');

  await page.getByRole('button', { name: /Volver a la p.gina inicial/ }).click();
  await waitForPreviewVersion(page, 'FILES-SPA-LATEST');

  await page.frameLocator('#preview-iframe').locator('#root-link').click();
  await waitForPreviewVersion(page, 'NESTED-READY');
  const rootLinkUrl = await getPreviewFrameUrl(page);
  assert.equal(new URL(rootLinkUrl).pathname, '/nested/page.html');
  assert.equal(new URL(rootLinkUrl).searchParams.get('v'), 'user');

  await page.getByRole('button', { name: /Volver a la p.gina inicial/ }).click();
  await waitForPreviewVersion(page, 'FILES-SPA-LATEST');
  await page.frameLocator('#preview-iframe').locator('#form-submit').click();
  await waitForPreviewVersion(page, 'NESTED-READY');
  const formUrl = await getPreviewFrameUrl(page);
  assert.equal(new URL(formUrl).pathname, '/nested/page.html');
  assert.match(formUrl, /from=form/);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('página completa conserva rutas limpias, iframes anidados, ventanas y formularios nativos', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const zip = new (require('../vendor/jszip.min.js'))();
  const documents = {
    'index.html': `<!doctype html><html><head><base href="/"><link rel="stylesheet" href="assets/site.css"></head><body>
      <h1 id="home">FULL-HOME</h1>
      <a id="docs" href="/docs?from=home&amp;filter=a%26b#section">Documentación</a>
      <a id="new-tab" href='/legal?from=popup&amp;label=O&apos;Brien#legal' target="_blank">Legal en otra pestaña</a>
      <a id="missing" href="/missing-page">Página inexistente</a>
      <iframe name="embedded" id="embedded" src="/embed/one"></iframe>
      <form action="/legal" method="get"><input name="from" value="form"><button id="send">Enviar</button></form>
      <form action="/legal" target="embedded" method="get"><input name="from" value="frame"><button id="send-frame" formaction="/embed/one">Enviar al marco</button></form>
      <button id="dynamic" onclick="const frame=document.createElement('iframe');frame.id='dynamic-frame';frame.src='/embed/deep/two.html';document.body.append(frame)">Crear iframe</button>
      <button id="dynamic-link" onclick="const a=document.createElement('a');a.id='added-link';a.href='/legal';a.textContent='Legal dinámico';document.body.append(a)">Crear enlace</button>
      <script type="module" src="assets/main.mjs"></script>
      <output id="module"></output>
    </body></html>`,
    'docs/index.html': `<!doctype html><html><body><h1 id="section">FULL-DOCS</h1><a id="back-home" href="../#home">Inicio</a><output id="data"></output><script>fetch('./data.json').then(r=>r.json()).then(d=>document.querySelector('#data').textContent=d.value)</script></body></html>`,
    'docs/data.json': '{"value":"DIRECTORY-FETCH"}',
    'legal.html': '<!doctype html><h1 id="legal">FULL-LEGAL</h1><a id="back-home" href="/#home">Inicio</a>',
    'embed/one.html': '<!doctype html><h1>FRAME-ONE</h1><iframe id="deep" src="/embed/deep/two.html"></iframe><a id="frame-legal" href="/legal">Legal</a>',
    'embed/deep/two.html': '<!doctype html><h1>FRAME-TWO</h1><a id="deep-home" href="/">Inicio</a>',
    'assets/site.css': 'body{--full-color:rgb(12, 34, 56);font-family:system-ui}iframe{height:160px}',
    'assets/main.mjs': `import {value} from './dep.mjs';const data=await fetch(new URL('./data.json',import.meta.url)).then(r=>r.json());document.querySelector('#module').textContent=value+':'+data.value;`,
    'assets/dep.mjs': 'export const value="MODULE";',
    'assets/data.json': '{"value":"FETCH"}',
    '404.html': '<!doctype html><h1>PROJECT-404</h1><a id="back-home" href="/">Inicio</a>'
  };
  for (const [name, content] of Object.entries(documents)) zip.file(`dist/${name}`, content);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#file-input').setInputFiles({
    name: 'full-page.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' })
  });
  await page.frameLocator('#preview-iframe').locator('#home').waitFor({ state: 'visible' });
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#btn-preview-full').click();
  const popup = await popupPromise;
  const errors = [];
  popup.on('pageerror', error => errors.push(error.message));
  await popup.waitForURL(/preview\.html/);
  const view = popup.frameLocator('#preview-frame');
  const siteFrame = () => popup.frames().find(item => item.parentFrame() === popup.mainFrame());
  const siteUrl = () => new URL(siteFrame().url());
  await view.locator('#module').filter({ hasText: 'MODULE:FETCH' }).waitFor({ state: 'visible' });
  assert.equal(await view.locator('body').evaluate(body => getComputedStyle(body).getPropertyValue('--full-color').trim()), 'rgb(12, 34, 56)');
  assert.equal(await siteFrame().evaluate(() => /\[native code\]/.test(fetch.toString()) && /\[native code\]/.test(XMLHttpRequest.toString())), true);
  await view.frameLocator('#embedded').getByRole('heading', { name: 'FRAME-ONE', exact: true }).waitFor({ state: 'visible' });
  await view.frameLocator('#embedded').frameLocator('#deep').getByRole('heading', { name: 'FRAME-TWO', exact: true }).waitFor({ state: 'visible' });
  // Firefox's isolated-world performance object can be stale during nested
  // frame navigation; the heading assertions already establish visibility.
  await view.frameLocator('#embedded').locator('#frame-legal').click({ force: browserName === 'firefox' });
  await view.frameLocator('#embedded').getByRole('heading', { name: 'FULL-LEGAL' }).waitFor({ state: 'visible' });
  await view.frameLocator('#embedded').locator('#back-home').click({ force: browserName === 'firefox' });
  await view.frameLocator('#embedded').getByRole('heading', { name: 'FULL-HOME' }).waitFor({ state: 'visible' });
  await view.locator('#send-frame').click();
  await view.frameLocator('#embedded').getByRole('heading', { name: 'FRAME-ONE', exact: true }).waitFor({ state: 'visible' });
  assert.match(await view.frameLocator('#embedded').locator('body').evaluate(() => location.search), /from=frame/);
  await view.locator('#dynamic').click();
  await view.frameLocator('#dynamic-frame').getByRole('heading', { name: 'FRAME-TWO' }).waitFor({ state: 'visible' });
  await view.locator('#dynamic-link').click();
  await view.locator('#added-link').click();
  await view.getByRole('heading', { name: 'FULL-LEGAL' }).waitFor({ state: 'visible' });
  await view.locator('#back-home').click();
  await view.locator('#home').waitFor({ state: 'visible' });
  const childPromise = popup.waitForEvent('popup');
  await view.locator('#new-tab').click();
  const child = await childPromise;
  await child.frameLocator('#preview-frame').getByRole('heading', { name: 'FULL-LEGAL' }).waitFor({ state: 'visible', timeout: 8000 });
  const childSite = new URL(child.frames().find(item => item.parentFrame() === child.mainFrame()).url());
  assert.equal(childSite.pathname, '/legal');
  assert.equal(childSite.searchParams.get('from'), 'popup');
  assert.equal(childSite.searchParams.get('label'), "O'Brien");
  assert.equal(childSite.hash, '#legal');
  await child.close();
  await view.locator('#docs').click();
  await view.locator('#data').filter({ hasText: 'DIRECTORY-FETCH' }).waitFor({ state: 'visible' });
  assert.equal(siteUrl().pathname, '/docs/');
  assert.equal(siteUrl().searchParams.get('from'), 'home');
  assert.equal(siteUrl().searchParams.get('filter'), 'a&b');
  assert.equal(siteUrl().hash, '#section');
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await view.locator('#data').filter({ hasText: 'DIRECTORY-FETCH' }).waitFor({ state: 'visible' });
  await view.locator('#back-home').click();
  await view.locator('#home').waitFor({ state: 'visible' });
  await view.locator('#send').click();
  await view.getByRole('heading', { name: 'FULL-LEGAL' }).waitFor({ state: 'visible' });
  assert.equal(siteUrl().pathname, '/legal');
  assert.equal(siteUrl().searchParams.get('from'), 'form');
  await popup.goBack();
  await view.locator('#home').waitFor({ state: 'visible' });
  await popup.goForward();
  await view.getByRole('heading', { name: 'FULL-LEGAL' }).waitFor({ state: 'visible' });
  await view.locator('#back-home').click();
  await view.locator('#missing').click();
  await view.getByRole('heading', { name: 'PROJECT-404' }).waitFor({ state: 'visible' });
  assert.equal(siteUrl().pathname, '/missing-page');
  await view.locator('#back-home').click();
  await view.locator('#home').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null);
  await popup.close();
  await page.close();
});

test('Simple aplica solo el último cambio, vuelve una vez y sigue editando', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitForMonaco(page);
  await page.evaluate(() => {
    window.__previewLoadCount = 0;
    document.querySelector('#preview-iframe').addEventListener('load', () => { window.__previewLoadCount += 1; });
  });

  await setEditorValue(page, '<!doctype html><html><body><h1 id="version">SIMPLE-START</h1><a id="simple-away" href="about:blank#away">Salir</a></body></html>');
  await waitForPreviewVersion(page, 'SIMPLE-START');

  for (let index = 0; index < 8; index += 1) {
    await setEditorValue(page, `<!doctype html><html><body><h1 id="version">SIMPLE-BURST-${index}</h1></body></html>`);
  }
  await setEditorValue(page, '<!doctype html><html><body><h1 id="version">SIMPLE-LATEST</h1></body></html>');
  await waitForPreviewVersion(page, 'SIMPLE-LATEST');
  const latestSrcdoc = await page.locator('#preview-iframe').getAttribute('srcdoc');
  assert.match(latestSrcdoc, /SIMPLE-LATEST/);
  assert.doesNotMatch(latestSrcdoc, /SIMPLE-BURST-7/);

  await setEditorValue(page, '');
  await page.frameLocator('#preview-iframe').locator('#version').waitFor({ state: 'hidden' });
  await setEditorValue(page, '<!doctype html><html><body><h1 id="version">SIMPLE-RETURN</h1><a id="simple-away" href="about:blank#away">Salir</a></body></html>');
  await waitForPreviewVersion(page, 'SIMPLE-RETURN');

  await page.frameLocator('#preview-iframe').locator('#simple-away').click();
  await page.getByRole('button', { name: 'Volver a la página inicial', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#btn-preview-home').disabled);
  await page.getByRole('button', { name: 'Volver a la página inicial', exact: true }).click();
  await waitForPreviewVersion(page, 'SIMPLE-RETURN');
  const loadsAfterHome = await page.evaluate(() => window.__previewLoadCount);
  await page.evaluate(() => {
    window.returnPreviewToHome();
    window.returnPreviewToHome();
  });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__previewLoadCount), loadsAfterHome);

  await setEditorValue(page, '<!doctype html><html><body><h1 id="version">SIMPLE-CONTINUES</h1></body></html>');
  await waitForPreviewVersion(page, 'SIMPLE-CONTINUES');
  assert.equal(await page.locator('#preview-iframe').count(), 1);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('la inicialización repetida no registra listeners efectivos adicionales', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    const original = EventTarget.prototype.addEventListener;
    const additions = [];
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (
        this === window ||
        this === document ||
        this?.id ||
        this?.classList?.contains?.('mobile-tab-btn')
      ) {
        additions.push({ type, target: this === window ? 'window' : this === document ? 'document' : this.id || this.className });
      }
      return original.call(this, type, listener, options);
    };
    window.__previewListenerAdditions = additions;
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitForMonaco(page);
  const beforeCount = await page.evaluate(() => window.__previewListenerAdditions.length);
  await page.evaluate(() => {
    window.initState();
    window.initState();
  });
  const afterCount = await page.evaluate(() => window.__previewListenerAdditions.length);

  assert.equal(afterCount, beforeCount);
  assert.equal(await page.locator('#preview-iframe').count(), 1);
  await page.close();
});

test('el service worker rechaza versiones fuera de orden sin controlar la aplicación', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const worker = await ensureProjectPreviewServiceWorker();
    if (!worker) throw new Error('Service worker no disponible');
    const sessionId = `stress-${Date.now().toString(36)}`;
    const send = message => new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeoutId = setTimeout(() => reject(new Error('Sin respuesta del service worker')), 3000);
      channel.port1.onmessage = event => {
        clearTimeout(timeoutId);
        resolve(event.data);
      };
      worker.postMessage(message, [channel.port2]);
    });
    const latest = await send({
      type: 'html-viewer:set-project',
      sessionId,
      version: 2,
      full: true,
      siteRoot: '',
      entries: [{ path: 'index.html', mimeType: 'text/html', isBinary: false, content: '<h1 id="version">SW-LATEST</h1>' }],
      removedPaths: []
    });
    const stale = await send({
      type: 'html-viewer:set-project',
      sessionId,
      version: 1,
      full: true,
      siteRoot: '',
      entries: [{ path: 'index.html', mimeType: 'text/html', isBinary: false, content: '<h1 id="version">SW-OLD</h1>' }],
      removedPaths: []
    });
    const url = new URL(`/${PROJECT_PREVIEW_PREFIX}/${sessionId}/index.html`, location.href);
    url.searchParams.set(PROJECT_PREVIEW_VERSION_PARAM, '2');
    return { latest, stale, url: url.href, controller: navigator.serviceWorker.controller?.scriptURL || '' };
  });

  assert.equal(result.latest.ok, true);
  assert.equal(result.latest.version, 2);
  assert.equal(result.stale.ok, true);
  assert.equal(result.stale.stale, true);
  assert.equal(result.stale.version, 2);
  assert.equal(result.controller, '');

  await page.evaluate(url => {
    const iframe = document.createElement('iframe');
    iframe.id = 'sw-version-probe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.src = url;
    document.body.appendChild(iframe);
  }, result.url);
  await page.frameLocator('#sw-version-probe').locator('#version').filter({ hasText: 'SW-LATEST' }).waitFor();
  assert.equal(await page.locator('#preview-iframe').count(), 1);
  await page.close();
});

test('Archivos reconstruye una sesión caducada antes de seguir un enlace', { skip: browserName !== 'chromium' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const failedProjectRequests = [];
  page.on('response', response => {
    if (response.status() >= 400 && response.url().includes('/__html_viewer_project__/')) {
      failedProjectRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await createSecondPageProject(page);

  const runtimeInfo = await getPreviewRuntimeInfo(page);
  assert.ok(runtimeInfo?.session, 'La pagina no informa de su sesion de proyecto');
  await expireStoredPreviewSession(page, runtimeInfo.session);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');

  await page.frameLocator('#preview-iframe').locator('#to-second').click();
  await waitForPreviewVersion(page, 'SECOND');
  assert.deepEqual(failedProjectRequests, []);

  await cdp.detach();
  await page.close();
});

test('Archivos soporta recursos, carreras, 50 ciclos, móvil, recarga y página completa', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  const failedProjectRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    // Monaco probes Safari's clipboard on user gestures. The automated
    // browser may deny that optional permission; it is not a preview error.
    const clipboardDenied = browserName === 'webkit' &&
      message.location().url.includes('/assets/vendor/monaco-editor/') &&
      message.text().includes('NotAllowedError');
    if (message.type() === 'error' && !clipboardDenied) consoleErrors.push(message.text());
  });
  page.on('response', response => {
    if (response.status() >= 400 && response.url().includes('/__html_viewer_project__/')) {
      failedProjectRequests.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.addInitScript(() => {
    window.__delayNextProjectMessage = false;
    if ('ServiceWorker' in window) {
      const originalPostMessage = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message, transfer) {
        if (window.__delayNextProjectMessage && message?.type === 'html-viewer:set-project') {
          window.__delayNextProjectMessage = false;
          const worker = this;
          setTimeout(() => originalPostMessage.call(worker, message, transfer), 300);
          return;
        }
        return originalPostMessage.call(this, message, transfer);
      };
    }
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await createSecondPageProject(page);
  await addNestedProjectAssets(page);

  const resourceState = await page.frameLocator('#preview-iframe').locator('body').evaluate(body => ({
    background: getComputedStyle(body).backgroundColor,
    fixtureReady: body.dataset.fixtureReady,
    scriptStatus: body.querySelector('#script-status')?.textContent,
    imageComplete: body.querySelector('#nested-image')?.complete,
    imageWidth: body.querySelector('#nested-image')?.naturalWidth
  }));
  assert.equal(resourceState.background, 'rgb(244, 247, 252)');
  assert.equal(resourceState.fixtureReady, 'true');
  assert.equal(resourceState.scriptStatus, 'JS-READY');
  assert.equal(resourceState.imageComplete, true);
  assert.ok(resourceState.imageWidth > 0);
  // Fixture construction updates incomplete pages before their assets exist.
  // Resource assertions above establish the starting point for the stress run.
  consoleErrors.length = 0;
  failedProjectRequests.length = 0;

  await page.frameLocator('#preview-iframe').locator('#to-second').click();
  await waitForPreviewVersion(page, 'SECOND');
  await openProjectFile(page, 'page.html');
  await page.evaluate(() => { window.__delayNextProjectMessage = true; });
  await setEditorValue(page, projectSecondHtml('SECOND-STALE'));
  await page.waitForTimeout(120);
  await setEditorValue(page, projectSecondHtml('SECOND-LATEST'));
  await waitForPreviewVersion(page, 'SECOND-LATEST');
  await page.waitForTimeout(500);
  assert.equal(await page.frameLocator('#preview-iframe').locator('#version').textContent(), 'SECOND-LATEST');

  await openProjectFile(page, 'styles.css');
  await setEditorValue(page, 'body{background:rgb(21,31,41);font-family:system-ui}#nested-image{width:32px;height:32px}');
  await page.waitForFunction(() => {
    const body = document.querySelector('#preview-iframe')?.contentDocument?.body;
    return body && getComputedStyle(body).backgroundColor === 'rgb(21, 31, 41)';
  });
  assert.equal(await page.frameLocator('#preview-iframe').locator('#version').textContent(), 'SECOND-LATEST');

  await openProjectFile(page, 'script.js');
  await setEditorValue(page, 'document.body.dataset.fixtureReady="updated";document.querySelector("#script-status").textContent="JS-UPDATED";');
  await page.frameLocator('#preview-iframe').locator('#script-status').filter({ hasText: 'JS-UPDATED' }).waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.frameLocator('#preview-iframe').locator('body').getAttribute('data-fixture-ready'), 'updated');
  assert.equal(await page.frameLocator('#preview-iframe').locator('#version').textContent(), 'SECOND-LATEST');

  await openProjectFile(page, 'index.html');
  await page.getByRole('button', { name: 'Volver a la página inicial', exact: true }).click();
  await waitForPreviewVersion(page, 'HOME');
  const sessionId = (await getPreviewRuntimeInfo(page))?.session;
  assert.ok(sessionId, 'La pagina no informa de su sesion de proyecto');

  let currentHomeVersion = 'HOME';
  for (let iteration = 0; iteration < 50; iteration += 1) {
    await page.frameLocator('#preview-iframe').locator('#to-second').click();
    await waitForPreviewVersion(page, 'SECOND-LATEST');
    await page.getByRole('button', { name: 'Volver a la página inicial', exact: true }).click();
    await waitForPreviewVersion(page, currentHomeVersion);

    currentHomeVersion = `HOME-${iteration}`;
    await setEditorValue(page, projectIndexHtml(currentHomeVersion));
    await waitForPreviewVersion(page, currentHomeVersion);

    const beforeReload = await getPreviewRuntimeInfo(page);
    await page.getByRole('button', { name: 'Recargar previsualización', exact: true }).click();
    const afterReload = await waitForPreviewSourceChange(page, beforeReload.sourceHref);
    assert.equal(afterReload.session, sessionId);
    await waitForPreviewVersion(page, currentHomeVersion);
    assert.equal(await page.locator('#preview-iframe').count(), 1);
  }

  assert.equal(await countStoredPreviewSessions(page), 1);

  await page.evaluate(() => {
    window.__mobilePreviewLoads = 0;
    document.querySelector('#preview-iframe').addEventListener('load', () => { window.__mobilePreviewLoads += 1; });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  for (let iteration = 0; iteration < 6; iteration += 1) {
    await page.locator('.mobile-tab-btn[data-tab="preview"]').click();
    await page.locator('.mobile-tab-btn[data-tab="editor"]').click();
  }
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.__mobilePreviewLoads), 0);
  assert.equal(await page.locator('#preview-iframe').count(), 1);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    const liveUrls = new Set();
    URL.createObjectURL = value => {
      const url = originalCreate(value);
      liveUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      liveUrls.delete(url);
      return originalRevoke(url);
    };
    window.__livePreviewBlobUrls = liveUrls;
  });
  for (let iteration = 0; iteration < 8; iteration += 1) {
    await page.getByRole('button', { name: 'Simple', exact: true }).click();
    await waitForPreviewVersion(page, currentHomeVersion);
    await page.getByRole('button', { name: 'Archivos', exact: true }).click();
  }
  await waitForPreviewVersion(page, currentHomeVersion);
  const blobState = await page.evaluate(() => ({
    live: window.__livePreviewBlobUrls.size,
    files: files.filter(file => !file.isFolder).length
  }));
  assert.ok(blobState.live <= blobState.files + 2, `Se conservaron ${blobState.live} Blob URLs para ${blobState.files} archivos`);

  const workerScriptsBeforePopup = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map(registration => registration.active?.scriptURL));
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#btn-preview-full').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  const fullPageVersion = popup.frameLocator('#preview-frame').locator('#version');
  await fullPageVersion.waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await fullPageVersion.textContent(), currentHomeVersion);
  await popup.close();
  await page.bringToFront();
  assert.deepEqual(await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map(registration => registration.active?.scriptURL)), workerScriptsBeforePopup);

  await page.frameLocator('#preview-iframe').locator('#to-second').click();
  await waitForPreviewVersion(page, 'SECOND-LATEST');
  await page.evaluate(() => {
    const pageFile = files.find(file => !file.isFolder && file.name.endsWith('/page.html'));
    if (!pageFile) throw new Error('No se encontró page.html para la prueba de borrado');
    deleteFile(pageFile.id);
  });
  await waitForPreviewVersion(page, currentHomeVersion);
  await page.getByText(/ya no existe\. Se volvió a la entrada\./).waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('.file-item').filter({ hasText: 'page.html' }).count(), 0);

  const serviceWorkerState = await page.evaluate(async () => ({
    controller: navigator.serviceWorker.controller?.scriptURL || '',
    scopes: (await navigator.serviceWorker.getRegistrations()).map(registration => registration.scope)
  }));
  assert.equal(serviceWorkerState.controller, '');
  assert.ok(serviceWorkerState.scopes.length >= 1);
  assert.ok(serviceWorkerState.scopes.every(scope => new URL(scope).pathname.endsWith('/__html_viewer_project__/')));
  assert.equal(await countStoredPreviewSessions(page), 1);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedProjectRequests, []);

  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#preview-iframe').count(), 1);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || ''), '');
  await setAvailableEditorValue(page, '<!doctype html><h1 id="version">RELOAD-COHERENT</h1>');
  await page.getByRole('button', { name: 'Archivos', exact: true }).click();
  await waitForPreviewVersion(page, 'RELOAD-COHERENT');
  assert.equal(await countStoredPreviewSessions(page), 1);
  assert.equal(await page.locator('#preview-iframe').count(), 1);
  await page.close();
});

test('Simple conserva el funcionamiento básico mediante file://', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(pathToFileURL(path.join(workspaceRoot, 'index.html')).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await setAvailableEditorValue(page, '<!doctype html><html><body><h1 id="version">FILE-SIMPLE</h1></body></html>');
  await waitForPreviewVersion(page, 'FILE-SIMPLE');
  assert.equal(await page.locator('#preview-iframe').count(), 1);
  assert.deepEqual(pageErrors, []);
  await page.close();
});
