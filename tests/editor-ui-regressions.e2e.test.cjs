const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const port = 4177;
const baseUrl = `http://127.0.0.1:${port}/`;
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
      if (Date.now() - started > 10000) return reject(new Error('UI regression server unavailable'));
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function newPage(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...options });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.monaco-editor textarea.inputarea').waitFor({ state: 'visible', timeout: 15000 });
  return { page, errors };
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
    once(server, 'exit').then(([code]) => { throw new Error(`Server exited (${code})`); })
  ]);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, 'exit').catch(() => {});
  }
});

test('text inputs keep native undo and editor zoom shortcuts work', async () => {
  const { page, errors } = await newPage();
  await page.click('#btn-sample');
  const code = await page.evaluate(() => editor.getValue());
  await page.click('#editor-filename');
  await page.keyboard.press('End');
  await page.keyboard.type('-draft');
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => editor.getValue()), code, 'Ctrl+Z in a text input must not undo the project');

  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+=');
  assert.equal(await page.evaluate(() => editorFontSize), 14);
  await page.keyboard.press('Control+-');
  await page.keyboard.press('Control+-');
  assert.equal(await page.evaluate(() => editorFontSize), 12);
  await page.keyboard.press('Control+0');
  assert.equal(await page.evaluate(() => editorFontSize), 13);
  assert.deepEqual(errors, []);
  await page.close();
});

test('destructive actions offer an undo that restores the previous state', async () => {
  const { page, errors } = await newPage();
  await page.click('#btn-sample');
  await page.click('#btn-clear');
  assert.equal(await page.evaluate(() => editor.getValue()), '');
  await page.locator('.toast-action').last().click();
  await page.waitForFunction(() => editor.getValue().includes('Silence also has a shape'));

  await page.click('#btn-mode-split');
  await page.locator('#file-list .file-item').first().waitFor();
  const before = await page.evaluate(() => files.map(file => file.name).sort());
  await page.evaluate(() => deleteFile(files.find(file => file.name.endsWith('script.js')).id));
  await page.locator('.toast-action').last().click();
  await page.waitForFunction(expected => files.length === expected, before.length);
  assert.deepEqual(await page.evaluate(() => files.map(file => file.name).sort()), before);
  assert.deepEqual(errors, []);
  await page.close();
});

test('export dialog manages focus, closes with Escape and reports ZIP failures', async () => {
  const { page, errors } = await newPage();
  await page.click('#btn-mode-split');
  await page.click('#btn-export');
  await page.waitForFunction(() => document.activeElement?.closest('#modal-export'));
  await page.keyboard.press('Escape');
  await page.locator('#modal-export').waitFor({ state: 'hidden' });

  await page.evaluate(() => {
    window.ensureJSZip = () => Promise.reject(new Error('unavailable'));
    return exportToZip();
  });
  await page.locator('.toast.error').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('English UI is fully localized, including diagnostics', async () => {
  const { page } = await newPage();
  assert.equal(await page.locator('#preview-console-summary').textContent(), 'No issues');
  assert.equal(await page.locator('#btn-preview-console-clear').textContent(), 'Clear');
  assert.equal(await page.locator('#btn-preview-console').getAttribute('aria-label'), 'Open diagnostics console');
  await page.evaluate(() => editor.setValue('<!doctype html><html><body><script>console.error("boom")</script></body></html>'));
  await page.click('#btn-preview-console');
  await page.locator('.preview-console-item').first().waitFor();
  assert.equal(await page.locator('.preview-console-kind').first().textContent(), 'JavaScript');
  assert.equal(await page.locator('#preview-console-summary').textContent(), '1 issue');
  await page.close();
});

test('explorer rows are keyboard navigable and asset paths are entry-relative', async () => {
  const { page } = await newPage();
  await page.click('#btn-mode-split');
  const tabStop = page.locator('#file-list [tabindex="0"]');
  assert.equal(await tabStop.count(), 1);
  await tabStop.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const label = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(name => document.getElementById('active-file-name').textContent.endsWith(name), label);
  assert.equal(await page.evaluate(() => getAssetReferencePath({ id: 'asset', name: `${getProjectRootFolder()}img/logo.png` })), 'img/logo.png');
  await page.close();
});

test('line numbers keep their gutter after crossing the mobile breakpoint', async () => {
  const { page } = await newPage();
  await page.click('#btn-sample');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => Math.abs(editor.getLayoutInfo().contentLeft - 44) <= 1);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => Math.abs(editor.getLayoutInfo().contentLeft - 68) <= 1);
  await page.close();
});
