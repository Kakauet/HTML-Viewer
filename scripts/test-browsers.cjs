const { spawnSync } = require('node:child_process');
for (const browser of ['chromium', 'firefox', 'webkit']) {
  console.log(`\nTesting ${browser}...`);
  const result = spawnSync(process.execPath, ['--test', 'tests/*.test.cjs'], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, PREVIEW_BROWSER: browser }
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
