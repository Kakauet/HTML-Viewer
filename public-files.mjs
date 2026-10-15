// Explicit publication boundary: never ship source, tests, tools or local data.
export const publicDirectories = ['assets'];
export const publicPages = ['index.html', '404.html', 'es/index.html', 'preview.html'];
export const publicFiles = [
  'index.html', 'es/index.html', '404.html', 'preview.html', 'preview-bridge.html', '_headers', 'app.bundle.js', 'preview-sw.js',
  'styles.min.css', 'lucide.min.js', 'jszip.min.js', 'LICENSE', 'THIRD-PARTY-NOTICES.md',
  'apple-touch-icon.png', 'favicon.ico', 'favicon-16x16.png',
  'favicon-32x32.png', 'favicon-48x48.png', 'favicon-96x96.png',
  'favicon-144x144.png', 'favicon-192x192.png',
  'logo.png'
];
