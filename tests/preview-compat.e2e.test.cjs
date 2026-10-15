const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { browserType, browserName } = require('./browser.cjs');

const workspaceRoot = path.resolve(__dirname, '..');
const port = Number(process.env.PREVIEW_COMPAT_PORT || 4174);
const baseUrl = `http://127.0.0.1:${port}/es/`;

let browser;
let serverProcess;

function waitForServer(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, response => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        retry();
      });
      request.on('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`El servidor de prueba no respondió en ${url}`));
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

before(async () => {
  serverProcess = spawn(process.execPath, ['scripts/local-server.cjs', String(port)], {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  serverProcess.stderr.on('data', chunk => process.stderr.write(chunk));
  await Promise.race([
    waitForServer(baseUrl),
    once(serverProcess, 'exit').then(([code]) => { throw new Error(`El servidor de prueba terminó antes de tiempo (${code})`); })
  ]);
  browser = await browserType.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await once(serverProcess, 'exit').catch(() => {});
  }
});

const siteFrame = page => page.frames().find(item => item.parentFrame() === page.mainFrame());

async function waitForFrameUrl(page, predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const frame = siteFrame(page);
    if (frame && predicate(new URL(frame.url()))) return new URL(frame.url());
    await page.waitForTimeout(50);
  }
  assert.fail(`URL inesperada: ${siteFrame(page)?.url()}`);
}

// A small static site in the style of a built Astro/Vite output: clean URLs
// (`/servicios/`), root-relative assets, hash links to the home page and
// consent state kept in localStorage and cookies.
async function importSite(page, extraFiles = {}) {
  const JSZip = require('../vendor/jszip.min.js');
  const zip = new JSZip();
  const common = '<link rel="stylesheet" href="/assets/site.css"><script src="/assets/site.js" defer></script>';
  const documents = {
    'index.html': `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Inicio</title>${common}</head><body>
      <nav><a id="to-services" href="/servicios/tasaciones">Tasaciones</a> <a id="to-blog" href="/blog/">Blog</a> <a id="to-contact" href="/#contacto">Contacto</a></nav>
      <h1 id="page">HOME</h1><section id="contacto"><h2>Contacto</h2></section>
      <output id="storage"></output><output id="route"></output></body></html>`,
    'servicios/tasaciones/index.html': `<!doctype html><html><head><meta charset="utf-8"><title>Tasaciones</title>${common}</head><body>
      <h1 id="page">SERVICIO</h1><a id="home" href="/">Inicio</a><a id="contact" href="/#contacto">Contacto</a><a id="legal" href="/html/aviso-legal">Legal</a></body></html>`,
    'blog/index.html': `<!doctype html><html><head><meta charset="utf-8"><title>Blog</title>${common}</head><body>
      <h1 id="page">BLOG</h1><a id="post" href="/blog/entrada">Entrada</a><a id="home" href="/">Inicio</a></body></html>`,
    'blog/entrada/index.html': `<!doctype html><html><head><meta charset="utf-8"><title>Entrada</title>${common}</head><body>
      <h1 id="page">ENTRADA</h1><a id="home" href="/">Inicio</a><button id="back" onclick="history.back()">Volver</button></body></html>`,
    'html/aviso-legal.html': `<!doctype html><html><head><meta charset="utf-8"><title>Legal</title>${common}</head><body>
      <h1 id="page">LEGAL</h1><a id="home" href="/">Inicio</a></body></html>`,
    'assets/site.css': 'body{--site-ready:1;font-family:system-ui}',
    'assets/site.js': `
      localStorage.setItem('consent', 'yes');
      document.cookie = 'visited=1; path=/';
      addEventListener('DOMContentLoaded', () => {
        const storage = document.querySelector('#storage');
        if (storage) storage.textContent = localStorage.getItem('consent') + ':' + document.cookie;
        const route = document.querySelector('#route');
        if (route) route.textContent = location.pathname + location.hash;
      });`,
    '404.html': '<!doctype html><title>404</title><h1 id="page">NOT-FOUND</h1>',
    ...extraFiles
  };
  for (const [name, content] of Object.entries(documents)) zip.file(`dist/${name}`, content);
  await page.locator('#file-input').setInputFiles({
    name: 'site.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' })
  });
  await page.frameLocator('#preview-iframe').locator('#page').filter({ hasText: 'HOME' }).waitFor({ timeout: 15000 });
}

test('un sitio con rutas limpias se recorre en la vista previa y en página completa', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await importSite(page);
  const view = page.frameLocator('#preview-iframe');

  assert.equal((await waitForFrameUrl(page, url => url.pathname === '/')).search, '');

  // Hash links to the home page keep the page and scroll to the anchor.
  await view.locator('#to-contact').click();
  await waitForFrameUrl(page, url => url.pathname === '/' && url.hash === '#contacto');
  await view.locator('#to-services').click();
  await view.locator('#page').filter({ hasText: 'SERVICIO' }).waitFor();
  await waitForFrameUrl(page, url => url.pathname === '/servicios/tasaciones/');
  await view.locator('#contact').click();
  await view.locator('#page').filter({ hasText: 'HOME' }).waitFor();
  await waitForFrameUrl(page, url => url.pathname === '/' && url.hash === '#contacto');
  await view.locator('#to-blog').click();
  await view.locator('#post').click();
  await view.locator('#page').filter({ hasText: 'ENTRADA' }).waitFor();
  await waitForFrameUrl(page, url => url.pathname === '/blog/entrada/');
  await view.locator('#back').click();
  await view.locator('#page').filter({ hasText: 'BLOG' }).waitFor();

  // A reload of the page keeps the route.
  await siteFrame(page).evaluate(() => location.reload());
  await view.locator('#page').filter({ hasText: 'BLOG' }).waitFor();
  await waitForFrameUrl(page, url => url.pathname === '/blog/');

  await view.locator('#home').click();
  await view.locator('#page').filter({ hasText: 'HOME' }).waitFor();

  // Full page: the same navigation inside the host window.
  await view.locator('#to-services').click();
  await view.locator('#page').filter({ hasText: 'SERVICIO' }).waitFor();
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#btn-preview-full').click();
  const popup = await popupPromise;
  await popup.waitForURL(/preview\.html/);
  const full = popup.frameLocator('#preview-frame');
  try { await full.locator('#page').filter({ hasText: 'SERVICIO' }).waitFor({ timeout: 8000 }); }
  catch (error) { console.error('FULL_PAGE', await Promise.all(popup.frames().map(async f => ({ url: f.url(), body: await f.evaluate(() => document.body.innerText) })))); throw error; }
  assert.equal(await popup.evaluate(() => window.opener), null);
  await full.locator('#legal').click();
  await full.locator('#page').filter({ hasText: 'LEGAL' }).waitFor();
  assert.equal(new URL(siteFrame(popup).url()).pathname, '/html/aviso-legal');
  assert.match(popup.url(), /#\/html\/aviso-legal$/);
  await full.locator('#home').click();
  await full.locator('#page').filter({ hasText: 'HOME' }).waitFor();
  await full.locator('#to-blog').click();
  await full.locator('#page').filter({ hasText: 'BLOG' }).waitFor();
  await popup.goBack();
  await full.locator('#page').filter({ hasText: 'HOME' }).waitFor();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await full.locator('#page').filter({ hasText: 'HOME' }).waitFor({ timeout: 15000 });
  await full.locator('#to-contact').click();
  await waitForFrameUrl(popup, url => url.pathname === '/' && url.hash === '#contacto');
  await popup.close();

  assert.deepEqual(errors, []);
  await page.close();
});

test('la página previsualizada no toca el almacenamiento ni los archivos del editor', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('consent', 'editor-value'); document.cookie = 'editor=1; path=/'; });
  await importSite(page);
  const view = page.frameLocator('#preview-iframe');

  await view.locator('#storage').filter({ hasText: 'yes:visited=1' }).waitFor();
  const editorState = await page.evaluate(() => ({ consent: localStorage.getItem('consent'), cookie: document.cookie }));
  assert.equal(editorState.consent, 'editor-value');
  assert.doesNotMatch(editorState.cookie, /visited/);

  const probe = await siteFrame(page).evaluate(async () => {
    const editorFile = await fetch('/app.bundle.js');
    const editorSource = await fetch('/es/');
    return {
      bundleStatus: editorFile.status,
      editorStatus: editorSource.status,
      worker: await navigator.serviceWorker.register('/preview-sw.js').then(() => 'registered', () => 'blocked'),
      keys: Object.keys(localStorage)
    };
  });
  assert.equal(probe.bundleStatus, 404);
  assert.equal(probe.editorStatus, 404);
  assert.equal(probe.worker, 'blocked');
  assert.deepEqual(probe.keys, ['consent']);
  await page.close();
});

test('el worker rechaza mensajes de proyectos y páginas ajenas tras reiniciarse', { skip: browserName !== 'chromium' }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await importSite(page);
  const sessionId = await page.evaluate(() => projectPreviewSessionId);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const denied = await siteFrame(page).evaluate(async sessionId => {
    // Bypass the instance stub through this frame's native getter. A worker
    // obtained from the parent's container would send with the parent's ID.
    const container = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serviceWorker').get.call(navigator);
    const registrations = await container.getRegistrations();
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
      registrations[0].active.postMessage({ type: 'html-viewer:touch-project', sessionId }, [channel.port2]);
    });
  }, sessionId);
  assert.equal(denied.ok, false);
  const unrelated = await page.context().newPage();
  await unrelated.goto(`${baseUrl}404.html`);
  const deniedUnrelated = await unrelated.evaluate(async sessionId => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
      registrations[0].active.postMessage({ type: 'html-viewer:touch-project', sessionId }, [channel.port2]);
    });
  }, sessionId);
  assert.equal(deniedUnrelated.ok, false);
  assert.equal(await page.evaluate(async sessionId => (await postProjectPreviewMessage({ type: 'html-viewer:touch-project', sessionId })).ok, sessionId), true);
  await page.frameLocator('#preview-iframe').locator('#to-blog').click();
  await page.frameLocator('#preview-iframe').locator('#page').filter({ hasText: 'BLOG' }).waitFor();
  await cdp.detach();
  await context.close();
});

test('importar una carpeta conserva lotes, recursos anidados y navegación', async () => {
  const fs = require('node:fs');
  const tree = directory => fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? { name: entry.name, children: tree(full) } : { name: entry.name, text: fs.readFileSync(full, 'utf8') };
  });
  const fixture = { name: 'project', children: tree(path.join(workspaceRoot, 'tests/fixtures/project')) };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const imported = await page.evaluate(async fixture => {
    const entry = item => item.children ? {
      name: item.name, isDirectory: true, isFile: false,
      createReader() {
        const children = item.children.map(entry);
        return { readEntries(callback) { queueMicrotask(() => callback(children.splice(0, 1))); } };
      }
    } : { name: item.name, isFile: true, isDirectory: false, file(callback) { callback(new File([item.text], item.name)); } };
    return importFolderEntry(entry(fixture));
  }, fixture);
  assert.equal(imported, true);
  const view = page.frameLocator('#preview-iframe');
  await view.locator('#version').filter({ hasText: 'HOME-V1' }).waitFor({ timeout: 15000 });
  assert.equal(await view.locator('#nested-image').evaluate(async image => { await image.decode(); return image.naturalWidth > 0; }), true);
  assert.equal(await view.locator('body').getAttribute('data-fixture-ready'), 'true');
  assert.equal(await view.locator('body').evaluate(body => getComputedStyle(body).backgroundColor), 'rgb(244, 247, 252)');
  await view.locator('#to-second').click();
  await view.locator('#version').filter({ hasText: 'SECOND-V1' }).waitFor();
  await page.close();
});

test('Simple aísla el documento del editor pero conserva localStorage y cookies', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const input = page.locator('.monaco-editor textarea.inputarea');
  await input.waitFor({ state: 'attached', timeout: 15000 });
  await page.evaluate(() => localStorage.setItem('editor-secret', 'top-secret'));
  await page.waitForFunction(() => monacoLoaded);
  await page.evaluate(html => editor.setValue(html), `<!doctype html><h1 id="state"></h1><script>
    let parentAccess = 'blocked';
    try { parent.document.title; parentAccess = 'open'; } catch {}
    localStorage.setItem('mine', '1');
    document.cookie = 'mine=1';
    document.querySelector('#state').textContent = [parentAccess, localStorage.getItem('mine'), localStorage.getItem('editor-secret'), document.cookie].join('|');
  <\/script>`);
  const state = page.frameLocator('#preview-iframe').locator('#state');
  await state.filter({ hasText: 'blocked|1||mine=1' }).waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('mine')), null);
  await page.close();
});

test('los archivos con codificación heredada se importan con sus acentos', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const html = '<!doctype html><html><head><meta charset="iso-8859-1"><title>Año</title></head><body><h1 id="page">Ñandú — niño</h1></body></html>'
    .replace('—', '-');
  await page.locator('#file-input').setInputFiles({
    name: 'legacy.html', mimeType: 'text/html', buffer: Buffer.from(html, 'latin1')
  });
  await page.frameLocator('#preview-iframe').locator('#page').filter({ hasText: 'Ñandú - niño' }).waitFor({ timeout: 10000 });
  assert.match(await page.evaluate(() => editor.getValue()), /charset="utf-8"/i);
  await page.close();
});
