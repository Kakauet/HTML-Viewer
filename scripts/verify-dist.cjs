const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const list = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(directory, entry.name);
  return entry.isDirectory() ? list(full) : [full];
});
const configuredMount = (process.env.BASE_PATH || '').replace(/\/$/, '');

async function verify(browser, mount, fullCheck, headers, port) {
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}${mount}/`;
  const server = spawn(process.execPath, ['scripts/local-server.cjs', String(port), 'dist', `--base-path=${mount}`, ...(headers ? ['--headers'] : [])], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit']
  });
  let context;
  try {
    await Promise.race([
      once(server.stdout, 'data'),
      once(server, 'exit').then(() => { throw new Error('Distribution server failed'); })
    ]);
    context = await browser.newContext();
    const page = await context.newPage();
    const errors = [], missing = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    page.on('response', response => {
      if (response.url().startsWith(origin) && response.status() >= 400) missing.push(response.url());
    });
    const checked = new Set();
    for (const relative of ['index.html', 'es/index.html', ...(fullCheck ? ['404.html'] : [])]) {
      const response = await page.goto(`${base}${relative}`, { waitUntil: 'load' });
      assert.equal(response.status(), 200, relative);
      const references = await page.locator('[src], [href]').evaluateAll(nodes => nodes.flatMap(node => {
        return ['src', 'href'].map(attr => node.getAttribute(attr)).filter(Boolean)
          .filter(value => !value.startsWith('#')).map(value => {
            try { return new URL(value, document.baseURI).href; } catch { return ''; }
          });
      }));
      for (const url of references.filter(url => url.startsWith(`${origin}/`))) {
        assert.ok(url.startsWith(base), `Resource escaped deployment path: ${url}`);
        if (checked.has(url)) continue;
        checked.add(url);
        const resource = await context.request.get(url);
        assert.equal(resource.ok(), true, `Missing published link/asset: ${url}`);
      }
    }
    assert.equal(requests.some(url => /^https?:/.test(url) && !url.startsWith(origin)), false, 'Editor startup contacted an external service');

    for (const lang of ['en', 'es']) {
      await page.goto(lang === 'en' ? base : `${base}es/`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof monacoLoaded !== 'undefined' && monacoLoaded);
      const frame = page.frameLocator('#preview-iframe');
      async function upload(marker) {
        await page.locator('#file-input').setInputFiles({
          name: 'same.html', mimeType: 'text/html',
          buffer: Buffer.from(`<!doctype html><html><body><h1 id="published-marker">${marker}</h1><script>window.publishedScriptWorks=true</script></body></html>`)
        });
        await frame.locator('#published-marker').filter({ hasText: marker }).waitFor();
        assert.equal(await frame.locator('body').evaluate(() => window.publishedScriptWorks), true);
      }
      await upload('A'); await upload('B');
      await page.locator('#btn-undo').click();
      await frame.locator('#published-marker').filter({ hasText: 'A' }).waitFor();
      await page.locator('#btn-redo').click();
      await frame.locator('#published-marker').filter({ hasText: 'B' }).waitFor();
      await page.locator('#btn-mode-split').click();
      // Project pages show their published URL, served by the worker under the editor's origin.
      await page.waitForFunction(() => { try { return Boolean(document.querySelector('#preview-iframe').contentWindow.__htmlViewerPreview); } catch { return false; } });
      await frame.locator('#published-marker').filter({ hasText: 'B' }).waitFor();
      assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null, 'Project worker controlled the editor');

      const zipBuffer = await page.evaluate(async () => {
        const Zip = await ensureJSZip();
        const zip = new Zip();
        zip.file('index.html', '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head><body><h1 id="published-marker">ZIP_OK</h1><a id="next-page" href="/pages/next.html">Next</a><script src="/assets/app.js"></script></body></html>');
        zip.file('assets/site.css', '#published-marker { color: rgb(1, 2, 3); }');
        zip.file('assets/app.js', 'window.projectScriptWorks = true;');
        zip.file('pages/next.html', '<!doctype html><h1 id="next-marker">NEXT_OK</h1>');
        return Array.from(await zip.generateAsync({ type: 'uint8array' }));
      });
      await page.locator('#file-input').setInputFiles({ name: 'project.zip', mimeType: 'application/zip', buffer: Buffer.from(zipBuffer) });
      await frame.locator('#published-marker').filter({ hasText: 'ZIP_OK' }).waitFor();
      assert.equal(await frame.locator('body').evaluate(() => window.projectScriptWorks), true);
      assert.equal(await frame.locator('#published-marker').evaluate(node => getComputedStyle(node).color), 'rgb(1, 2, 3)');
      await frame.locator('#next-page').click();
      await frame.locator('#next-marker').waitFor();

      await page.locator('#btn-about').click();
      assert.equal(await page.locator('#about-panel').getAttribute('aria-hidden'), 'false');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#about-panel').getAttribute('aria-hidden'), 'true');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile overflow');
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.locator('.language-link').click();
      assert.equal(await page.locator('html').getAttribute('lang'), lang === 'en' ? 'es' : 'en');
    }
    assert.deepEqual(missing, [], 'Missing local runtime assets');
    assert.deepEqual(errors, [], 'JavaScript errors in published site');
    console.log(`dist verified at ${mount || '/'} ${headers ? 'with hosting headers' : 'without custom headers'}: EN/ES, Monaco, HTML/ZIP, undo/redo, project SW, CSS/JS, navigation, help and mobile.`);
  } finally {
    await context?.close();
    if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  }
}

(async () => {
  const files = list(dist);
  for (const item of ['src', 'tests', 'scripts', 'node_modules', '.git', 'vendor', 'about', 'guides', 'legal', 'es/guias', 'docs', '.claude', '.codex']) {
    assert.equal(fs.existsSync(path.join(dist, item)), false, `Extra content in dist: ${item}`);
  }
  assert.ok(fs.existsSync(path.join(dist, '.nojekyll')));
  for (const notice of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'assets/licenses/Lucide.txt', 'assets/licenses/JSZip.txt', 'assets/licenses/Pako.txt', 'assets/licenses/Pako-zlib.txt']) {
    assert.ok(fs.statSync(path.join(dist, notice)).size > 0, `Missing license: ${notice}`);
  }
  assert.deepEqual(files.filter(file => file.endsWith('.html')).map(file => path.relative(dist, file).split(path.sep).join('/')).sort(), ['404.html', 'es/index.html', 'index.html', 'preview.html']);
  const browser = await chromium.launch({ headless: true });
  try {
    await verify(browser, configuredMount, true, true, 4186);
    await verify(browser, configuredMount === '/HTML-Viewer' ? '/nested/repository' : '/HTML-Viewer', false, false, 4187);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
