// Generate only the editor in English/Spanish and a small error page.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import vm from 'node:vm';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const app = await readFile('src/app/00-config-state.js', 'utf8');
const dictionaries = vm.runInNewContext(`${app.slice(app.indexOf('const TRANSLATIONS ='), app.indexOf('\nfunction t('))}\nTRANSLATIONS;`, {}, { timeout: 1000 });

function localize(html, lang) {
  const dict = dictionaries[lang];
  html = html.replace(/(<([\w-]+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)[^<]*(<\/\2>)/g, (all, open, tag, key, close) => {
    if (!dict[key]) throw Error(`Missing translation: ${lang}/${key}`);
    return `${open}${escape(dict[key])}${close}`;
  });
  for (const attr of ['title', 'placeholder', 'aria-label']) html = html.replace(/<[a-z][^>]*>/gi, tag => {
    const key = tag.match(new RegExp(`data-i18n-${attr}="([^"]+)"`))?.[1];
    if (!key) return tag;
    if (!dict[key]) throw Error(`Missing translation: ${lang}/${key}`);
    const value = escape(dict[key]);
    const regex = new RegExp(`(?<![\\w-])${attr}="[^"]*"`);
    return regex.test(tag) ? tag.replace(regex, `${attr}="${value}"`) : tag.replace(/>$/, ` ${attr}="${value}">`);
  });
  return html;
}

function helpContent(es) {
  const sections = es ? [
    ['Editar y previsualizar', 'Usa Simple para un documento HTML. Usa Archivos para un proyecto con HTML, CSS, JavaScript y recursos en carpetas. La vista previa se actualiza al editar.'],
    ['Importar y guardar', 'Importa un HTML o un ZIP con los botones o arrastrándolo al editor. Exporta como HTML, ZIP o carpeta local cuando tu navegador lo permita.'],
    ['Almacenamiento local', 'Los archivos se procesan en tu navegador. El tema, la distribución y la recuperación del editor usan almacenamiento local. Exporta una copia para conservar tu trabajo; borrar los datos del navegador elimina la recuperación.'],
    ['Vista previa de proyectos', 'El modo Archivos requiere HTTPS o localhost. Ejecuta código preparado para el navegador; los proyectos que necesitan un servidor o una compilación deben prepararse antes de importarlos. Los scripts y recursos de la vista previa pueden acceder a Internet.']
  ] : [
    ['Edit and preview', 'Use Simple for one HTML document. Use Files for a project with HTML, CSS, JavaScript and assets in folders. The preview updates as you edit.'],
    ['Import and save', 'Import HTML or ZIP with the buttons or by dragging it into the editor. Export HTML, ZIP or a local folder when your browser supports it.'],
    ['Local storage', 'Files are processed in your browser. Theme, layout and editor recovery use local browser storage. Export a copy to keep your work; clearing browser data removes recovery.'],
    ['Project preview', 'Files mode requires HTTPS or localhost. Use browser-ready code; projects that need a server or a build must be prepared before import. Scripts and resources in the preview can access the Internet.']
  ];
  const shortcuts = es
    ? [['Ctrl + Z', 'Deshacer'], ['Ctrl + Y', 'Rehacer'], ['Ctrl + S', 'Exportar'], ['Ctrl + O', 'Importar'], ['Ctrl + P', 'Abrir a página completa'], ['Ctrl + +/−', 'Zoom del editor'], ['Ctrl + 0', 'Restablecer zoom']]
    : [['Ctrl + Z', 'Undo'], ['Ctrl + Y', 'Redo'], ['Ctrl + S', 'Export'], ['Ctrl + O', 'Import'], ['Ctrl + P', 'Open full page'], ['Ctrl + +/−', 'Editor zoom'], ['Ctrl + 0', 'Reset zoom']];
  return sections.map(([title, body]) => `<section class="about-section"><h3>${title}</h3><p>${body}</p></section>`).join('\n') +
    `<section class="about-section"><h3>${es ? 'Atajos de teclado' : 'Keyboard shortcuts'}</h3><div class="about-shortcuts-list">${shortcuts.map(([keys, label]) => `<div class="about-shortcut-row"><kbd>${keys}</kbd><span>${label}</span></div>`).join('')}</div><p class="about-note">${es ? 'En macOS, usa ⌘ en lugar de Ctrl.' : 'On macOS, use ⌘ instead of Ctrl.'}</p></section>`;
}

// A previewed page can navigate outside the preview's virtual URLs (a
// reload of its clean URL, `location.href = '/x'`). Pages of this site must
// never start inside a preview frame: they stop, and a nested project frame
// is sent back to the project URL. The editor or the full-page host re-routes
// the preview frame itself when it loads.
const previewGuard = `<script>(()=>{try{const f=window.frameElement;if(!f)return;const root=f.hasAttribute('data-html-viewer-preview');const project=root?null:window.parent.__htmlViewerPreview;if(!root&&!project)return;window.stop();if(root){const own=window.parent.location.pathname.replace(/\\/$/,''),back=location.pathname.replace(/\\/$/,'')===own;window.parent.postMessage({channel:'html-viewer-preview-control',type:'navigate',recover:true,target:back?'/':location.href},location.origin)}if(project)location.replace(new URL(location.pathname.replace(/^\\/+/,'')+location.search+location.hash,project.siteBase).href)}catch{}})();</script>`;

// The editor's preview frame and the full-page host share one policy.
const previewSandbox = app.match(/const PREVIEW_SANDBOX_TOKENS = '([^']+)';/)?.[1];
if (!previewSandbox) throw Error('PREVIEW_SANDBOX_TOKENS not found');
const previewAllow = [
  'accelerometer', 'autoplay', 'camera', 'clipboard-read', 'clipboard-write', 'display-capture', 'encrypted-media',
  'fullscreen', 'geolocation', 'gyroscope', 'magnetometer', 'microphone', 'midi', 'picture-in-picture',
  'screen-wake-lock', 'xr-spatial-tracking'
].map(feature => `${feature} *`).concat([
  'payment', 'usb', 'serial', 'hid', 'bluetooth', 'publickey-credentials-get', 'identity-credentials-get'
].map(feature => `${feature} 'none'`)).join('; ');
const previewTokens = { previewGuard, previewSandbox, previewAllow: escape(previewAllow) };

const template = await readFile('src/site/editor-shell.html', 'utf8');
for (const lang of ['en', 'es']) {
  const es = lang === 'es';
  const prefix = es ? '../' : './';
  const description = es ? 'Editor de HTML, CSS y JavaScript con vista previa e importación de proyectos.' : 'HTML, CSS and JavaScript editor with live preview and project import.';
  const replacements = {
    lang,
    head: `<meta name="viewport" content="width=device-width, initial-scale=1"><title>HTML Viewer</title><meta name="description" content="${description}"><meta name="theme-color" content="#8842FD"><link rel="icon" href="${prefix}favicon.ico"><link rel="apple-touch-icon" href="${prefix}apple-touch-icon.png">`,
    skip: es ? 'Saltar al editor' : 'Skip to editor',
    editorNav: es ? 'Controles del editor' : 'Editor controls',
    languageLink: `<a class="language-link" href="${es ? '../' : './es/'}" lang="${es ? 'en' : 'es'}">${es ? 'English' : 'Español'}</a>`,
    helpContent: helpContent(es),
    nojs: es ? 'Activa JavaScript para utilizar el editor.' : 'Enable JavaScript to use the editor.',
    ...previewTokens
  };
  let html = localize(template.replace(/\{\{(\w+)\}\}/g, (match, key) => replacements[key] ?? match), lang);
  html = html.replace(/((?:src|href)=")\/(?=assets\/|styles\.min\.css|(?:app\.bundle|lucide\.min)\.js)/g, `$1${prefix}`);
  html = html.replaceAll("url('/assets/", `url('${prefix}assets/`);
  if (/\{\{\w+\}\}/.test(html)) throw Error('Unresolved editor template token');
  const file = es ? 'es/index.html' : 'index.html';
  if (es) await mkdir('es', { recursive: true });
  await writeFile(file, `<!-- Generated by build-site.mjs; edit src/site/editor-shell.html. -->\n${html}`);
}

const host = await readFile('src/site/preview-host.html', 'utf8');
const hostHtml = host.replace(/\{\{(\w+)\}\}/g, (match, key) => previewTokens[key] ?? match);
if (/\{\{\w+\}\}/.test(hostHtml)) throw Error('Unresolved preview host token');
await writeFile('preview.html', `<!-- Generated by build-site.mjs; edit src/site/preview-host.html. -->\n${hostHtml}`);

// Missing URLs can be nested. GitHub Actions supplies Pages' base_path.
const rawBase = process.env.BASE_PATH || '/';
if (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(rawBase) || rawBase.split('/').includes('..')) throw Error('Invalid BASE_PATH');
const base = rawBase === '/' ? '/' : `${rawBase.replace(/\/$/, '')}/`;
await writeFile('404.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${previewGuard}<meta name="robots" content="noindex"><title>Page not found · HTML Viewer</title><style>body{font-family:system-ui;max-width:40rem;margin:15vh auto;padding:2rem;background:#0b0d13;color:#fff}a{color:#c394ff}</style></head><body><h1>Page not found / Página no encontrada</h1><p><a href="${base}">Open HTML Viewer / Abrir HTML Viewer</a></p></body></html>\n`);
console.log('Generated English/Spanish editor, full-page preview host and 404 page.');
