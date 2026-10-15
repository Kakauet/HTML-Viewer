import { access, stat, readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const monacoRoot = `assets/vendor/monaco-editor/${manifest.devDependencies['monaco-editor']}`;

const requiredRuntimeAssets = [
  `${monacoRoot}/LICENSE.txt`,
  ...['editor.main.js', 'editor.main.css', 'editor.worker.js', 'html.worker.js',
    'css.worker.js', 'json.worker.js', 'ts.worker.js'
  ].map(file => `${monacoRoot}/browser/${file}`),
  'assets/fonts/inter-latin-v20.woff2',
  'assets/fonts/outfit-latin-v15.woff2',
  'assets/fonts/jetbrains-mono-latin-v24.woff2',
  'assets/fonts/OFL-Inter.txt',
  'assets/fonts/OFL-Outfit.txt',
  'assets/fonts/OFL-JetBrains-Mono.txt',
  'assets/licenses/Lucide.txt',
  'assets/licenses/JSZip.txt',
  'assets/licenses/Pako.txt',
  'assets/licenses/Pako-zlib.txt',
];

for (const file of requiredRuntimeAssets) {
  await access(file);
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Runtime asset is empty or invalid: ${file}`);
  }
}

console.log(`Verified ${requiredRuntimeAssets.length} local runtime assets.`);
