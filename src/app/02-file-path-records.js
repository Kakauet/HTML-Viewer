function getFileExtension(filename) {
  const basename = filename.split('/').pop() || '';
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex === -1 ? '' : basename.substring(dotIndex + 1).toLowerCase();
}

function createFileId(prefix = 'file') {
  return `${prefix}-${Date.now()}-${fileIdCounter++}`;
}

function decodeUrlPathComponent(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

// Text files are edited and served as UTF-8. Older sites are often saved as
// Windows-1252/ISO-8859-1 or UTF-16, so decode with the encoding the file
// declares (BOM, <meta charset> or @charset) instead of assuming UTF-8.
function decodeTextFileBytes(input, filename = '') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const decode = (label, view = bytes) => {
    try { return new TextDecoder(label).decode(view); } catch { return null; }
  };
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return decode('utf-8', bytes.subarray(3));
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return decode('utf-16le', bytes.subarray(2)) ?? '';
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return decode('utf-16be', bytes.subarray(2)) ?? '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {}
  // Not valid UTF-8: honor a declared charset, otherwise use the web's
  // default legacy encoding.
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 2048));
  const ext = getFileExtension(filename);
  const declared = ext === 'css'
    ? /^@charset\s+["']([\w.:-]+)["']/i.exec(head)?.[1]
    : (/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1]);
  const declaredText = declared && !/^utf-?(?:8|16)/i.test(declared) ? decode(declared.toLowerCase()) : null;
  const text = declaredText ?? decode('windows-1252') ?? '';
  // The text is stored and exported as UTF-8 from now on; keep its
  // declaration truthful so the exported file opens correctly.
  if (!declared) return text;
  return ext === 'css'
    ? text.replace(/^@charset\s+["'][\w.:-]+["']/i, '@charset "utf-8"')
    : text.replace(/(<meta[^>]+charset\s*=\s*["']?\s*)[\w.:-]+/i, '$1utf-8');
}

async function readTextFile(file) {
  return decodeTextFileBytes(new Uint8Array(await file.arrayBuffer()), file.name || '');
}

function normalizeReferencePathValue(path) {
  return decodeUrlPathComponent(String(path || '').trim()).replace(/\\/g, '/');
}

function normalizeProjectPath(path, { folder = false } = {}) {
  let normalized = String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');

  const cleanParts = [];
  normalized
    .split('/')
    .forEach(part => {
      if (!part || part === '.') return;
      if (part === '..') {
        cleanParts.pop();
        return;
      }
      cleanParts.push(part);
    });

  normalized = cleanParts.join('/');

  if (folder && normalized && !normalized.endsWith('/')) {
    normalized += '/';
  }
  return normalized;
}

function getParentPath(path) {
  const cleanPath = normalizeProjectPath(path, { folder: path.endsWith('/') });
  const parts = cleanPath.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
}

function getBaseName(path) {
  const parts = normalizeProjectPath(path, { folder: path.endsWith('/') }).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function joinProjectPath(parentPath, name, { folder = false } = {}) {
  const cleanParent = normalizeProjectPath(parentPath, { folder: true });
  const cleanName = normalizeProjectPath(name).split('/').filter(Boolean).join('/');
  return normalizeProjectPath(`${cleanParent}${cleanName}`, { folder });
}

function getMimeTypeForFilename(filename) {
  const ext = getFileExtension(filename);
  switch (ext) {
    case 'html':
    case 'htm':
      return 'text/html';
    case 'css':
      return 'text/css';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'text/javascript';
    case 'ts':
    case 'tsx':
      return 'text/typescript';
    case 'json':
    case 'map':
      return 'application/json';
    case 'webmanifest':
      return 'application/manifest+json';
    case 'md':
      return 'text/markdown';
    case 'txt':
      return 'text/plain';
    case 'csv':
      return 'text/csv';
    case 'yaml':
    case 'yml':
      return 'application/yaml';
    case 'xml':
      return 'application/xml';
    case 'svg':
      return 'image/svg+xml';
    case 'apng':
      return 'image/apng';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'ico':
      return 'image/x-icon';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    case 'ttf':
      return 'font/ttf';
    case 'otf':
      return 'font/otf';
    case 'eot':
      return 'application/vnd.ms-fontobject';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    case 'm4a':
      return 'audio/mp4';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    case 'pdf':
      return 'application/pdf';
    case 'wasm':
      return 'application/wasm';
    // Less common web formats: browsers check these types for subtitles,
    // feeds, 3D models and media sources.
    case 'vtt':
      return 'text/vtt';
    case 'jsonld':
      return 'application/ld+json';
    case 'geojson':
      return 'application/geo+json';
    case 'xhtml':
      return 'application/xhtml+xml';
    case 'rss':
      return 'application/rss+xml';
    case 'atom':
      return 'application/atom+xml';
    case 'gltf':
      return 'model/gltf+json';
    case 'glb':
      return 'model/gltf-binary';
    case 'jxl':
      return 'image/jxl';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    case 'opus':
    case 'oga':
      return 'audio/ogg';
    case 'ogv':
      return 'video/ogg';
    case 'm4v':
      return 'video/mp4';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

function isTextFilename(filename) {
  return TEXT_EXTENSIONS.has(getFileExtension(filename));
}

function isEditableFile(file) {
  return file && !file.isFolder && !file.isBinary;
}

// One document contract for both Monaco and the fallback textarea.  Callers
// that need the currently displayed document should use this rather than
// guessing from the selected entry or from a compiled preview URL.
function getCurrentEditorDocumentText() {
  if (monacoLoaded && editor?.getModel?.()) {
    return editor.getModel().getValue();
  }
  return fallbackTextarea?.value || '';
}

function getCurrentEditorDocumentModel() {
  return monacoLoaded ? (editor?.getModel?.() || null) : null;
}

function createTextFileRecord(name, content = '', options = {}) {
  const cleanName = normalizeProjectPath(name);
  return {
    id: options.id || createFileId('file'),
    name: cleanName,
    content,
    type: getFileExtension(cleanName) || 'plaintext',
    mimeType: options.mimeType || getMimeTypeForFilename(cleanName),
    isBinary: false,
    size: typeof options.size === 'number' ? options.size : new Blob([content]).size,
    order: typeof options.order === 'number' ? options.order : nextFileOrder++
  };
}

function createBinaryFileRecord(name, blob, options = {}) {
  const cleanName = normalizeProjectPath(name);
  return {
    id: options.id || createFileId('asset'),
    name: cleanName,
    content: '',
    blob,
    type: getFileExtension(cleanName) || 'asset',
    mimeType: options.mimeType || blob?.type || getMimeTypeForFilename(cleanName),
    isBinary: true,
    size: typeof options.size === 'number' ? options.size : (blob?.size || 0),
    order: typeof options.order === 'number' ? options.order : nextFileOrder++
  };
}

function createFolderRecord(name, options = {}) {
  const cleanName = normalizeProjectPath(name, { folder: true });
  return {
    id: options.id || createFileId('folder'),
    name: cleanName,
    isFolder: true,
    type: 'folder',
    content: '',
    mimeType: 'inode/directory',
    isBinary: false,
    size: 0,
    order: typeof options.order === 'number' ? options.order : nextFileOrder++
  };
}

function getFileText(file) {
  if (!file || file.isFolder) return '';
  if (!isRestoringHistory && editorMode === 'unified' && file.id === getEntryFile()?.id) {
    const currentModel = getCurrentEditorDocumentModel();
    if (currentModel && currentModel === unifiedModel) return currentModel.getValue();
    if (!monacoLoaded && fallbackTextarea) return fallbackTextarea.value;
  }
  if (monacoLoaded && fileModels[file.id]) {
    return fileModels[file.id].getValue();
  }
  return file.content || '';
}

function getFileBlob(file, contentOverride = null) {
  if (!file || file.isFolder) return new Blob([]);
  if (file.isBinary && file.blob) {
    return file.blob;
  }
  const content = contentOverride !== null ? contentOverride : getFileText(file);
  return new Blob([content], { type: `${file.mimeType || getMimeTypeForFilename(file.name)};charset=utf-8` });
}

// Virtual file system state
const defaultFolder = currentLocale === 'es' ? 'proyecto' : 'project';
const defaultCssComment = currentLocale === 'es' ? '/* Hoja de estilo del proyecto */' : '/* Project stylesheet */';
const defaultJsComment = currentLocale === 'es' ? '// Código JavaScript del proyecto\nconsole.log("¡Proyecto cargado!");' : '// Project JavaScript code\nconsole.log("Project loaded!");';

let files = [
  createTextFileRecord(`${defaultFolder}/index.html`, DEFAULT_SAMPLE_CODE, { id: '1' }),
  createTextFileRecord(`${defaultFolder}/styles.css`, `${defaultCssComment}\nbody {\n  font-family: 'Inter', sans-serif;\n  padding: 24px;\n}`, { id: '2' }),
  createTextFileRecord(`${defaultFolder}/script.js`, defaultJsComment, { id: '3' })
];
