const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', process.argv[3] || '.');
const port = Number(process.env.PORT || process.argv[2] || 8000);
const host = process.env.HOST || '127.0.0.1';
// Mount dist under a subpath to verify static hosting without redirects
// or hosting-specific response headers.
const baseOption = process.argv.find(arg => arg.startsWith('--base-path='));
const previewOption = process.argv.find(arg => arg.startsWith('--preview-origin='));
const previewOrigin = previewOption ? new URL(previewOption.slice('--preview-origin='.length)).origin : '';
const mount = baseOption ? baseOption.slice('--base-path='.length).replace(/\/$/, '') : '';
if (mount && (!mount.startsWith('/') || mount.includes('..'))) throw Error('Invalid base path');
const headerRules = [];
const redirects = new Map();
if (process.argv.includes('--headers')) {
  const redirectFile = path.join(root, '_redirects');
  if (fs.existsSync(redirectFile)) {
    for (const line of fs.readFileSync(redirectFile, 'utf8').split(/\r?\n/)) {
      const rule = line.trim().match(/^(\/\S*)\s+(\/\S*)\s+(301|302)!?$/);
      if (rule) redirects.set(rule[1], { to: rule[2], status: Number(rule[3]) });
    }
  }
  let rule;
  for (const line of fs.readFileSync(path.join(root, '_headers'), 'utf8').split(/\r?\n/)) {
    if (line.startsWith('/')) {
      const pattern = line.trim().split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      rule = { match: new RegExp(`^${pattern}$`), headers: {} };
      headerRules.push(rule);
    } else if (rule && /^\s+[^:]+:/.test(line)) {
      const separator = line.indexOf(':');
      rule.headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip'
};

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, `http://${host}:${port}`);
  if (mount && !url.pathname.startsWith(`${mount}/`)) return null;
  const decodedPath = decodeURIComponent(url.pathname.slice(mount.length)).replace(/^[/\\]+/, '');
  let filePath = path.resolve(root, decodedPath || 'index.html');
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return null;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  return filePath;
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  let filePath;
  const requestedUrl = new URL(request.url, `http://${host}:${port}`);
  const redirect = redirects.get(requestedUrl.pathname);
  if (redirect) {
    response.writeHead(redirect.status, { Location: `${redirect.to}${requestedUrl.search}` });
    response.end();
    return;
  }
  try {
    filePath = resolveRequestPath(request.url);
  } catch {
    filePath = null;
  }

  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const errorPage = path.join(root, '404.html');
    response.writeHead(404, {
      'Content-Type': fs.existsSync(errorPage) ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex'
    });
    if (request.method === 'HEAD') response.end();
    else if (fs.existsSync(errorPage)) fs.createReadStream(errorPage).pipe(response);
    else response.end('Not found');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (path.basename(filePath) === 'preview-sw.js') {
    headers['Service-Worker-Allowed'] = '/';
  }
  const pathname = new URL(request.url, `http://${host}:${port}`).pathname.slice(mount.length);
  for (const rule of headerRules) {
    if (rule.match.test(pathname)) Object.assign(headers, rule.headers);
  }

  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  if (previewOrigin && extension === '.html') {
    response.end(fs.readFileSync(filePath, 'utf8').replace(/(<meta name="html-viewer-preview-origin" content=")[^"]*/, `$1${previewOrigin}`));
  } else fs.createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`HTML Visor: http://${host}:${port}`);
});
