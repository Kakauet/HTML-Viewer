// Single entry point that regenerates every build artifact the site serves.
// Run after editing anything under src/app/, src/site/, styles.css, or the
// set of icons used in the UI:
//
//   node build.mjs
//
// Individual generation steps can still be run on their own; this entry point
// also verifies runtime dependencies and fingerprints browser-cached assets.

import { fileURLToPath } from 'node:url';

console.log('Building HTML Viewer assets...\n');

// All generation scripts resolve their inputs from the project root.
process.chdir(fileURLToPath(new URL('.', import.meta.url)));

await import('./build-vendor.mjs');        // pinned local Monaco + browser-global JSZip
await import('./build-app-bundle.mjs');   // src/app/* -> app.bundle.js
await import('./build-site.mjs');          // shared editor -> static EN/ES HTML
await import('./build-lucide-subset.mjs'); // vendor/lucide.full.min.js -> lucide.min.js (subset)
await import('./build-css.mjs');           // styles.css/layout.css -> *.min.css
await import('./verify-runtime-assets.mjs'); // fail fast if local Monaco/fonts are incomplete
await import('./build-asset-versions.mjs');  // content hashes in HTML asset URLs
await import('./build-dist.mjs');           // only publishable files -> dist/

console.log('\nAll assets built.');
