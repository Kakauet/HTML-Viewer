const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { browserType } = require('./browser.cjs');
const editorOrigin = 'http://127.0.0.1:4191', previewOrigin = 'http://127.0.0.1:4192';
let browser, api;
const servers = [];

before(async () => {
  for (const port of [4191, 4192]) {
    const server = spawn(process.execPath, ['scripts/local-server.cjs', String(port), '.', ...(port === 4192 ? ['--headers'] : [`--preview-origin=${previewOrigin}`])], {
      cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true
    });
    servers.push(server);
    await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw Error('Isolation test server failed'); })]);
  }
  api = http.createServer((request, response) => {
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ answer: 42 }));
  }).listen(4193, '127.0.0.1');
  await once(api, 'listening');
  browser = await browserType.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (api) await new Promise(resolve => api.close(resolve));
  for (const server of servers) if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
});

async function openProject(blockPreviewWorker = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('framenavigated', frame => { if (frame.url().includes('bridge') || frame.url().includes('chrome-error')) errors.push(`frame: ${frame.url()}`); });
  if (blockPreviewWorker) await page.route(`${previewOrigin}/preview-bridge.html*`, route => route.fulfill({
    contentType: 'text/html', body: '<script>addEventListener("message",e=>e.ports[0]?.postMessage({ok:false,error:"Storage blocked"}));</script>'
  }));
  await page.goto(editorOrigin);
  await page.waitForFunction(() => typeof monacoLoaded !== 'undefined' && monacoLoaded);
  await page.evaluate(() => localStorage.setItem('editor-secret', 'private'));
  const zip = new (require('../vendor/jszip.min.js'))();
  const files = {
    'dist/index.html': '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head><body><h1 id="marker">WAIT</h1><output id="data"></output><output id="api"></output><a id="about" href="/about/">About</a><button id="spa" onclick="history.pushState({},\'\',\'/dashboard?tab=1\')">SPA</button><script type="module" src="/assets/app.js"></script></body></html>',
    'dist/assets/site.css': '#marker{color:rgb(1,2,3)}',
    'dist/assets/helper.js': 'export const marker="READY";',
    'dist/assets/app.js': 'import {marker} from "./helper.js";document.querySelector("#marker").textContent=marker;fetch("/data.json").then(r=>r.json()).then(d=>document.querySelector("#data").textContent=d.message);fetch("http://127.0.0.1:4193/api").then(r=>r.json()).then(d=>document.querySelector("#api").textContent=d.answer);',
    'dist/data.json': '{"message":"FETCH_OK"}',
    'dist/about/index.html': '<!doctype html><h1 id="about-page">ABOUT</h1><a id="home" href="/">Home</a>'
  };
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  await page.locator('#file-input').setInputFiles({ name: 'dist.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  try {
    await page.frameLocator('#preview-iframe').locator('#marker').filter({ hasText: 'READY' }).waitFor({ timeout: 20000 });
  } catch (error) {
    console.error({ errors, frames: page.frames().map(frame => frame.url()), state: await page.evaluate(() => ({ remote: IS_REMOTE_PREVIEW, phase: previewLifecycle.phase, mode: previewLifecycle.mode, preview: previewIframe.src })) });
    throw error;
  }
  return page;
}

test('otro origen aísla el editor y conserva dist, módulos, recursos, API, SPA y página completa', async () => {
  const page = await openProject();
  const view = page.frameLocator('#preview-iframe');
  const frame = () => page.frames().find(frame => frame.parentFrame() === page.mainFrame() && frame.url().startsWith(previewOrigin) && !frame.url().includes('preview-bridge.html'));
  const isolation = await frame().evaluate(() => {
    let blocked = false;
    try { parent.document.body.dataset.imported = 'bad'; } catch { blocked = true; }
    return { blocked, secret: localStorage.getItem('editor-secret'), origin: location.origin };
  });
  assert.deepEqual(isolation, { blocked: true, secret: null, origin: previewOrigin });
  assert.equal(await view.locator('#marker').evaluate(el => getComputedStyle(el).color), 'rgb(1, 2, 3)');
  await view.locator('#data').filter({ hasText: 'FETCH_OK' }).waitFor();
  await view.locator('#api').filter({ hasText: '42' }).waitFor();
  await view.locator('#spa').click();
  try { await page.waitForFunction(() => previewLifecycle.projectPath.replace(/\/$/, '') === 'dist/dashboard', null, { timeout: 5000 }); }
  catch (error) { console.error(await page.evaluate(() => ({ state: previewLifecycle, snapshot: remotePreviewSnapshot, version: projectPreviewVersion }))); throw error; }
  assert.match(frame().url(), /\/dashboard\?tab=1$/);
  await page.evaluate(() => {
    const file = files.find(file => file.name.endsWith('helper.js'));
    openFile(file.id);
    editor.setValue('export const marker="UPDATED";');
  });
  await view.locator('#marker').filter({ hasText: 'UPDATED' }).waitFor();
  assert.match(frame().url(), /\/dashboard\?tab=1$/);
  await view.locator('#about').click();
  await view.locator('#about-page').waitFor();
  await frame().evaluate(() => history.back());
  await view.locator('#marker').filter({ hasText: 'UPDATED' }).waitFor();
  await frame().evaluate(() => location.reload());
  await view.locator('#marker').filter({ hasText: 'UPDATED' }).waitFor();
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#btn-preview-full').click();
  const popup = await popupPromise;
  await popup.frameLocator('#preview-frame').locator('#marker').filter({ hasText: 'UPDATED' }).waitFor();
  assert.equal(new URL(popup.url()).origin, editorOrigin);
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null);
  assert.equal(await page.evaluate(() => document.body.dataset.imported || ''), '');
  assert.equal(await page.evaluate(() => localStorage.getItem('editor-secret')), 'private');
  await popup.close();
  await page.close();
});

test('Simple con recursos del proyecto también usa el origen separado', async () => {
  const page = await openProject();
  await page.locator('#btn-mode-unified').click();
  const view = page.frameLocator('#preview-iframe');
  await view.locator('#marker').filter({ hasText: 'READY' }).waitFor();
  assert.equal(await view.locator('body').evaluate(() => {
    try { return Boolean(parent.document); } catch { return false; }
  }), false);
  assert.equal(await view.locator('body').evaluate(() => location.origin), previewOrigin);
  await page.close();
});

test('si el navegador bloquea el origen separado conserva la reproducción y avisa', async () => {
  const page = await openProject(true);
  assert.equal(await page.evaluate(() => IS_REMOTE_PREVIEW), false);
  await page.locator('.toast.info').filter({ hasText: /Compatibility mode/ }).waitFor();
  const view = page.frameLocator('#preview-iframe');
  assert.equal(await view.locator('body').evaluate(() => location.origin), editorOrigin);
  await view.locator('#about').click();
  await view.locator('#about-page').waitFor();
  await page.close();
});
