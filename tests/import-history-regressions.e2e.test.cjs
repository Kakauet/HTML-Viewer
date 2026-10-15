const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { browserType, browserName } = require('./browser.cjs');

const root = path.resolve(__dirname, '..');
const port = 4175;
// These assertions use Spanish control labels; the language is now URL-stable.
const baseUrl = `http://127.0.0.1:${port}/es/`;
let server;
let browser;

function waitForServer(url) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const request = http.get(url, response => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        retry();
      });
      request.on('error', retry);
      request.setTimeout(500, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - started > 10000) return reject(new Error('Servidor de regresiones no disponible'));
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function newPage(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...options });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  return page;
}

async function waitForMonaco(page) {
  await page.waitForFunction(() => typeof monacoLoaded !== 'undefined' && monacoLoaded);
  await page.locator('.monaco-editor textarea.inputarea').waitFor({ state: 'attached', timeout: 15000 });
}

// Seed fixtures through Monaco's API; keyboard behaviour has dedicated UI tests.
async function setMonacoValue(page, value) {
  await waitForMonaco(page);
  await page.evaluate(value => editor.setValue(value), value);
}

async function importHtml(page, marker, name = 'same.html') {
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'text/html',
    buffer: Buffer.from(`<!doctype html><html><body><h1 id="marker">${marker}</h1></body></html>`)
  });
  await page.frameLocator('#preview-iframe').locator('#marker').filter({ hasText: marker }).waitFor({ timeout: 10000 });
}

before(async () => {
  server = spawn(process.execPath, ['scripts/local-server.cjs', String(port)], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  await Promise.race([
    waitForServer(baseUrl),
    once(server, 'exit').then(([code]) => { throw new Error(`Servidor terminó (${code})`); })
  ]);
  browser = await browserType.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, 'exit').catch(() => {});
  }
});

test('importación, deshacer/rehacer y preview comparten la misma revisión', async () => {
  const page = await newPage();
  await waitForMonaco(page);
  await importHtml(page, 'A');
  await importHtml(page, 'B');
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  await page.frameLocator('#preview-iframe').locator('#marker').filter({ hasText: 'A' }).waitFor();
  let state = await page.evaluate(() => ({ editor: editor.getValue(), sameModel: editor.getModel() === unifiedModel }));
  state.preview = await page.frameLocator('#preview-iframe').locator('body').innerText();
  assert.match(state.editor, />A</);
  assert.match(state.preview, /A/);
  assert.equal(state.sameModel, true);

  await page.getByRole('button', { name: 'Rehacer', exact: true }).click();
  await page.frameLocator('#preview-iframe').locator('#marker').filter({ hasText: 'B' }).waitFor();
  await importHtml(page, 'C');
  state = { editor: await page.evaluate(() => editor.getValue()), preview: await page.frameLocator('#preview-iframe').locator('body').innerText() };
  assert.match(state.editor, />C</);
  assert.match(state.preview, /C/);
  await page.close();
});

test('importación lenta no puede sobrescribir una intención posterior', async () => {
  const page = await newPage();
  await waitForMonaco(page);
  await page.evaluate(() => {
    const originalText = File.prototype.text;
    File.prototype.text = function () {
      if (this.name === 'slow.html') return new Promise(resolve => setTimeout(() => resolve(originalText.call(this)), 500));
      return originalText.call(this);
    };
  });
  await page.locator('#file-input').setInputFiles({ name: 'slow.html', mimeType: 'text/html', buffer: Buffer.from('<h1 id="marker">OLD</h1>') });
  await page.waitForTimeout(40);
  await page.locator('#file-input').setInputFiles({ name: 'fast.html', mimeType: 'text/html', buffer: Buffer.from('<h1 id="marker">NEW</h1>') });
  await page.frameLocator('#preview-iframe').locator('#marker').filter({ hasText: 'NEW' }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(650);
  assert.equal(await page.frameLocator('#preview-iframe').locator('#marker').textContent(), 'NEW');
  assert.match(await page.locator('.monaco-editor textarea.inputarea').inputValue(), /NEW/);
  await page.close();
});

test('Archivos conserva HTML íntegro y Monaco conecta el archivo activo tras carga tardía', async () => {
  const page = await newPage();
  await page.route('**/browser/editor.main.js', async route => {
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.continue();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const source = '<!doctype html><html><head><style media="print">body{color:red}</style></head><body><h1 id="marker">START</h1><script type="application/json" id="data">{"answer":42}</script><script type="module">document.querySelector("#marker").textContent="MODULE_OK"</script></body></html>';
  await page.locator('#file-input').setInputFiles({ name: 'faithful.html', mimeType: 'text/html', buffer: Buffer.from(source) });
  await page.getByRole('button', { name: 'Archivos', exact: true }).click();
  await page.frameLocator('#preview-iframe').locator('#marker').filter({ hasText: 'MODULE_OK' }).waitFor({ timeout: 10000 });
  await waitForMonaco(page);
  await page.frameLocator('#preview-iframe').locator('#marker').filter({ hasText: 'MODULE_OK' }).waitFor({ timeout: 10000 });
  const state = await page.evaluate(() => ({
    source: getFileText(getEntryFile()),
    mode: editorMode,
    sameModel: editor.getModel() === unifiedModel
  }));
  state.color = await page.frameLocator('#preview-iframe').locator('body').evaluate(body => getComputedStyle(body).color);
  assert.equal(state.source, source);
  assert.equal(state.mode, 'split');
  assert.equal(state.sameModel, false);
  assert.equal(state.color, 'rgb(0, 0, 0)');
  await page.close();
});

test('resolver, movimiento, formulario GET y arrastre no interfieren con el contenido', async () => {
  const page = await newPage();
  await waitForMonaco(page);
  const result = await page.evaluate(() => {
    const rewritten = resolveVirtualPathsLazy(
      '<script>const x = `src="asset.png"`;</script><div data-src="asset.png"></div><img src="//cdn.example/lib.js">',
      'demo/index.html',
      path => `/virtual/${path}`
    );
    loadProjectFiles([
      createTextFileRecord('demo/index.html', '<form action="one.html?old=1"><button id="send" formaction="two.html">go</button></form>'),
      createTextFileRecord('demo/one.html', '<p>ONE</p>'),
      createTextFileRecord('demo/two.html', '<p id="two">TWO</p>'),
      createTextFileRecord('demo/page.html', '<img id="moved" src="assets/pic.svg">'),
      createTextFileRecord('demo/assets/pic.svg', '<svg></svg>'),
      createFolderRecord('demo/sub/')
    ], '', 'demo');
    const pageFile = files.find(file => file.name === 'demo/page.html');
    moveVfsItemToFolder({ kind: 'file', id: pageFile.id, path: pageFile.name }, 'demo/sub/');
    return {
      rewritten,
      moved: getFileText(pageFile),
      doctype: null
    };
  });
  assert.match(result.rewritten, /src="`asset\.png`|src="asset\.png"/);
  assert.match(result.rewritten, /data-src="asset\.png"/);
  assert.match(result.rewritten, /src="\/\/cdn\.example\/lib\.js"/);
  assert.match(result.moved, /\.\.\/assets\/pic\.svg/);
  await page.frameLocator('#preview-iframe').locator('#send').click();
  await page.frameLocator('#preview-iframe').locator('#two').waitFor({ timeout: 5000 });
  assert.equal(await page.frameLocator('#preview-iframe').locator('#two').textContent(), 'TWO');
  await page.close();
});

test('exportación Simple no serializa URLs Blob y el doctype/drag del usuario se conservan', async () => {
  const page = await newPage();
  await waitForMonaco(page);
  await setMonacoValue(page, '<!doctype html><html><body><img id="drag" draggable="true"><h1 id="marker">PORTABLE</h1></body></html>');
  await page.frameLocator('#preview-iframe').locator('#marker').waitFor();
  const contentState = await page.frameLocator('#preview-iframe').locator('html').evaluate(html => {
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true });
    const image = html.querySelector('#drag');
    image.dispatchEvent(event);
    return { doctype: html.ownerDocument.doctype?.name, draggable: image.draggable, prevented: event.defaultPrevented };
  });
  assert.deepEqual(contentState, { doctype: 'html', draggable: true, prevented: false });
  const download = page.waitForEvent('download');
  await page.locator('#btn-export').click();
  const artifact = await download;
  const exported = require('node:fs').readFileSync(await artifact.path(), 'utf8');
  assert.doesNotMatch(exported, /blob:/i);
  assert.match(exported, /PORTABLE/);
  await page.close();
});
