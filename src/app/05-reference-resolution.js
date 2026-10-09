// Helper to split unified HTML into HTML, CSS, JS components
function splitUnifiedCode(unifiedHtml) {
  let css = '';
  let js = '';
  let html = unifiedHtml;

  // Extract <style> blocks
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch;
  while ((styleMatch = styleRegex.exec(unifiedHtml)) !== null) {
    css += styleMatch[1].trim() + '\n\n';
  }
  html = html.replace(styleRegex, '');

  // Extract inline <script> blocks (only those without 'src' attribute)
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(unifiedHtml)) !== null) {
    const openTag = scriptMatch[0];
    if (!/src\s*=/i.test(openTag)) {
      js += scriptMatch[1].trim() + '\n\n';
      html = html.replace(scriptMatch[0], '');
    }
  }

  // Inject link and script tags to reference the separate files
  if (css.trim()) {
    const linkTag = '\n<link rel="stylesheet" href="styles.css">';
    // Only inject if not already present
    if (!/href\s*=\s*(['"])(?:\.\/|\/)?styles\.css\1/i.test(html)) {
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/(<\/head>)/i, `${linkTag}\n$1`);
      } else if (/<html[^>]*>/i.test(html)) {
        html = html.replace(/(<html[^>]*>)/i, `$1\n<head>${linkTag}\n</head>`);
      } else {
        html = linkTag + '\n' + html;
      }
    }
  }

  if (js.trim()) {
    const scriptTag = '\n<script src="script.js"></script>';
    // Only inject if not already present
    if (!/src\s*=\s*(['"])(?:\.\/|\/)?script\.js\1/i.test(html)) {
      if (/(<\/body>)/i.test(html)) {
        html = html.replace(/(<\/body>)/i, `${scriptTag}\n$1`);
      } else if (/(<\/html>)/i.test(html)) {
        html = html.replace(/(<\/html>)/i, `${scriptTag}\n$1`);
      } else {
        html = html + '\n' + scriptTag;
      }
    }
  }

  return {
    html: html.trim(),
    css: css.trim(),
    js: js.trim()
  };
}

function replaceProjectWithSplitSource(unifiedHtml, { emptyAsSingleFile = false } = {}) {
  const rootFolder = getProjectRootFolder();
  // Switching modes is a representation change, not an extraction step.
  // Keep the document byte-for-byte intact: JSON scripts, import maps,
  // modules, media attributes and script ordering all carry semantics.
  const content = emptyAsSingleFile && !String(unifiedHtml || '').trim()
    ? ''
    : String(unifiedHtml || '');
  files = [createTextFileRecord(rootFolder + 'index.html', content, { id: '1' })];

  // Keep the long-standing empty editor slots for a plain document so old
  // projects that immediately open styles.css/script.js remain editable. A
  // document that already contains style/script content stays a single
  // faithful HTML file; no inline code or special script type is extracted.
  if (
    content.trim() &&
    !/<style\b/i.test(content) &&
    !/<script\b/i.test(content)
  ) {
    files.push(
      createTextFileRecord(rootFolder + 'styles.css', '', { id: '2' }),
      createTextFileRecord(rootFolder + 'script.js', '', { id: '3' })
    );
  }
  openFileIds = ['1'];

  activeFileId = '1';
  selectedEntryFileId = '1';
  normalizeProjectFiles();
}

// Helper to resolve relative paths to canonical virtual file system paths
function resolveRelativePath(basePath, relativePath) {
  const rawRelativePath = String(relativePath || '').trim();
  if (!rawRelativePath || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(rawRelativePath)) return null;

  const isRootRelative = rawRelativePath.startsWith('/');
  let cleanRel = normalizeReferencePathValue(rawRelativePath);
  if (isRootRelative) return cleanRel.replace(/^\/+/, '');
  if (cleanRel.startsWith('./')) cleanRel = cleanRel.substring(2);

  const baseParts = basePath.split('/').filter(Boolean);
  const relParts = cleanRel.split('/');

  for (const part of relParts) {
    if (part === '.' || part === '') {
      continue;
    } else if (part === '..') {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }

  return baseParts.join('/');
}

function getReferencePathCandidates(hostFilename, refPath) {
  const rawReference = String(refPath || '').trim();
  if (!rawReference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(rawReference)) return [];
  const { path } = splitPathSuffix(refPath);
  const canonicalPath = resolveRelativePath(getDirectoryPath(hostFilename), path);
  if (!canonicalPath) return [];

  const candidates = [canonicalPath];
  if (path.startsWith('/')) {
    const siteRoot = getProjectPreviewSiteRootPath();
    if (siteRoot) {
      candidates.push(normalizeProjectPath(`${siteRoot}/${canonicalPath}`));
    }
  }

  return candidates.filter((candidate, index, arr) => candidate && arr.indexOf(candidate) === index);
}

function splitPathSuffix(refPath) {
  const suffixMatch = String(refPath).match(/([?#].*)$/);
  return {
    path: suffixMatch ? refPath.slice(0, suffixMatch.index) : refPath,
    suffix: suffixMatch ? suffixMatch[0] : ''
  };
}

function appendReferenceSuffix(resolvedValue, suffixValue) {
  const resolved = String(resolvedValue || '');
  const suffix = String(suffixValue || '');
  if (!suffix) return resolved;

  const hashIndex = suffix.indexOf('#');
  const query = hashIndex === -1 ? suffix : suffix.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : suffix.slice(hashIndex);
  if (/^(?:blob|data):/i.test(resolved)) return `${resolved}${hash}`;

  let result = resolved.split('#')[0];
  if (query.startsWith('?') && query.length > 1) {
    result += `${result.includes('?') ? '&' : '?'}${query.slice(1)}`;
  }
  return `${result}${hash}`;
}

function getDirectoryPath(filename) {
  const cleanName = normalizeProjectPath(filename);
  const lastSlashIndex = cleanName.lastIndexOf('/');
  return lastSlashIndex === -1 ? '' : cleanName.substring(0, lastSlashIndex);
}

function getCommonProjectRootPath() {
  const filePaths = files
    .filter(file => !file.isFolder)
    .map(file => normalizeProjectPath(file.name))
    .filter(Boolean);
  if (filePaths.length === 0) return '';
  if (filePaths.some(path => !path.includes('/'))) return '';

  const firstSegment = filePaths[0].split('/')[0];
  return filePaths.every(path => path.startsWith(`${firstSegment}/`)) ? firstSegment : '';
}

function getProjectPreviewSiteRootPath() {
  const entryFile = getEntryFile();
  if (!entryFile) return getCommonProjectRootPath();

  const entryPath = normalizeProjectPath(entryFile.name);
  const entryDir = getDirectoryPath(entryPath);
  const entryBase = getBaseName(entryPath).toLowerCase();
  if ((entryBase === 'index.html' || entryBase === 'index.htm') && entryDir) {
    return entryDir;
  }

  const commonRoot = getCommonProjectRootPath();
  if (commonRoot && entryPath.startsWith(`${commonRoot}/`)) {
    return commonRoot;
  }

  return '';
}

function getStaticRouteCandidates(path) {
  const cleanPath = normalizeProjectPath(path);
  const candidates = [];
  const add = candidate => {
    const normalized = normalizeProjectPath(candidate);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  if (!cleanPath) {
    add('index.html');
    add('index.htm');
    return candidates;
  }

  add(cleanPath);
  const lastSegment = cleanPath.split('/').pop() || '';
  const hasExtension = /\.[^/.]+$/.test(lastSegment);
  if (!hasExtension) {
    add(`${cleanPath}.html`);
    add(`${cleanPath}.htm`);
    add(`${cleanPath}/index.html`);
    add(`${cleanPath}/index.htm`);
  }
  if (cleanPath.endsWith('/')) {
    add(`${cleanPath}index.html`);
    add(`${cleanPath}index.htm`);
  }
  return candidates;
}

function findProjectFileByStaticRoute(path, { preferSiteRoot = false } = {}) {
  const cleanPath = normalizeProjectPath(path);
  const siteRoot = getProjectPreviewSiteRootPath();
  const scopedPath = siteRoot && cleanPath && !cleanPath.toLowerCase().startsWith(`${siteRoot.toLowerCase()}/`)
    ? normalizeProjectPath(`${siteRoot}/${cleanPath}`)
    : cleanPath;
  const scopes = preferSiteRoot ? [scopedPath, cleanPath] : [cleanPath, scopedPath];

  for (const scope of scopes.filter((scope, index, arr) => arr.indexOf(scope) === index)) {
    for (const candidate of getStaticRouteCandidates(scope)) {
      const file = files.find(item => !item.isFolder && normalizeProjectPath(item.name).toLowerCase() === candidate.toLowerCase());
      if (file) return file;
    }
  }
  return null;
}

function makeRelativePath(fromFilename, toPath) {
  const fromDirParts = getDirectoryPath(fromFilename).split('/').filter(Boolean);
  const toParts = normalizeProjectPath(toPath).split('/').filter(Boolean);

  while (fromDirParts.length && toParts.length && fromDirParts[0] === toParts[0]) {
    fromDirParts.shift();
    toParts.shift();
  }

  const relativeParts = [
    ...fromDirParts.map(() => '..'),
    ...toParts
  ];
  return relativeParts.length ? relativeParts.join('/') : getBaseName(toPath);
}

function resolveReferenceValue(refPath, fileMap, entryFilename) {
  const { suffix } = splitPathSuffix(refPath);
  for (const candidatePath of getReferencePathCandidates(entryFilename, refPath)) {
    if (fileMap[candidatePath]) {
      return appendReferenceSuffix(fileMap[candidatePath], suffix);
    }
  }
  return null;
}

function resolveSrcset(value, fileMap, entryFilename) {
  return splitSrcsetCandidates(value).map(part => {
    const trimmed = part.trim();
    if (!trimmed) return part;
    const pieces = trimmed.split(/\s+/);
    const resolved = resolveReferenceValue(pieces[0], fileMap, entryFilename);
    if (!resolved) return part;
    pieces[0] = resolved;
    return pieces.join(' ');
  }).join(', ');
}

function splitSrcsetCandidates(value) {
  const candidates = [];
  let current = '';
  const source = String(value || '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || '';
    if (char === ',' && (!/^\s*data:/i.test(current) || /\s/.test(next))) {
      candidates.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  candidates.push(current);
  return candidates;
}

function rewriteCssImportReference(match, quote, refPath, resolved) {
  const safeQuote = quote || '"';
  return match.replace(refPath, resolved).replace(/@import\s+url\(\s*([^'")\s][^)]*)\)/i, `@import url(${safeQuote}$1${safeQuote})`);
}

function resolveCssUrls(content, fileMap, entryFilename) {
  return rewriteCssReferences(content, refPath => resolveReferenceValue(refPath, fileMap, entryFilename));
}

function rewriteCssReferences(content, transform) {
  const source = String(content || '');
  let result = '';
  let index = 0;
  const copyQuoted = quote => {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') index += 2;
      else if (source[index++] === quote) break;
    }
    return source.slice(start, index);
  };
  const readUrlFunction = () => {
    const start = index;
    index += 4; // url(
    while (index < source.length && /\s/.test(source[index])) index += 1;
    let quote = '';
    if (source[index] === '"' || source[index] === "'") quote = source[index++];
    const valueStart = index;
    if (quote) {
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index++] === quote) break;
      }
    } else {
      while (index < source.length && source[index] !== ')') index += 1;
    }
    const valueEnd = quote ? index - 1 : index;
    while (index < source.length && source[index] !== ')') index += 1;
    if (index < source.length) index += 1;
    const raw = source.slice(valueStart, valueEnd).trim();
    const transformed = transform(raw);
    if (!transformed || transformed === raw) return source.slice(start, index);
    const safeQuote = quote || '"';
    return `url(${safeQuote}${transformed}${safeQuote})`;
  };

  while (index < source.length) {
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      result += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (source[index] === '"' || source[index] === "'") {
      result += copyQuoted(source[index]);
      continue;
    }
    if (source.slice(index, index + 7).toLowerCase() === '@import' && /\s/.test(source[index + 7] || '')) {
      result += source.slice(index, index + 7);
      index += 7;
      while (index < source.length && /\s/.test(source[index])) result += source[index++];
      if (source[index] === '"' || source[index] === "'") {
        const quote = source[index++];
        const valueStart = index;
        while (index < source.length) {
          if (source[index] === '\\') index += 2;
          else if (source[index++] === quote) break;
        }
        const raw = source.slice(valueStart, index - 1);
        const transformed = transform(raw);
        result += `${quote}${transformed || raw}${quote}`;
      }
      continue;
    }
    if (source.slice(index, index + 4).toLowerCase() === 'url(') {
      result += readUrlFunction();
      continue;
    }
    result += source[index++];
  }
  return result;
}

function rewriteHtmlReferenceAttributes(content, transform) {
  const source = String(content || '');
  const attributeDecoder = document.createElement('textarea');
  const rewriteTag = tag => tag.replace(
    /(^|\s)([A-Za-z][\w:-]*)(\s*=\s*)(?:(["'])([\s\S]*?)\4|([^\s"'=<>`]+))/g,
    (match, prefix, attrName, equals, quote, quotedValue, unquotedValue) => {
      const lowerName = attrName.toLowerCase();
      if (!new Set(['href', 'src', 'action', 'poster', 'formaction', 'srcset', 'style']).has(lowerName)) return match;
      attributeDecoder.innerHTML = quote ? quotedValue : unquotedValue;
      const original = attributeDecoder.textContent;
      const next = lowerName === 'style'
        ? rewriteCssReferences(original, transform)
        : lowerName === 'srcset'
        ? resolveSrcsetWithTransform(original, transform)
        : transform(original, { tagName: tag.match(/^<\s*([\w:-]+)/)?.[1]?.toLowerCase() || '', attrName: lowerName });
      if (!next || next === original) return match;
      const outputQuote = quote || '"';
      const escaped = String(next).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(outputQuote === '"' ? /"/g : /'/g, outputQuote === '"' ? '&quot;' : '&#39;');
      return `${prefix}${attrName}${equals}${outputQuote}${escaped}${outputQuote}`;
    }
  );

  let result = '';
  let index = 0;
  while (index < source.length) {
    const tagStart = source.indexOf('<', index);
    if (tagStart === -1) {
      result += source.slice(index);
      break;
    }
    result += source.slice(index, tagStart);
    if (source.startsWith('<!--', tagStart)) {
      const end = source.indexOf('-->', tagStart + 4);
      const stop = end === -1 ? source.length : end + 3;
      result += source.slice(tagStart, stop);
      index = stop;
      continue;
    }
    const tagEnd = findHtmlTagEnd(source, tagStart);
    if (tagEnd === -1) {
      result += source.slice(tagStart);
      break;
    }
    const tag = source.slice(tagStart, tagEnd + 1);
    result += /^<\/?[!?]/.test(tag) ? tag : rewriteTag(tag);
    const nameMatch = tag.match(/^<\s*([A-Za-z][\w:-]*)/);
    const name = nameMatch?.[1]?.toLowerCase();
    index = tagEnd + 1;

    // Raw-text elements must never be scanned as HTML.  CSS is handled by its
    // own tokenizer; script and template text remain byte-for-byte intact.
    if (name === 'style' && !/^<\//.test(tag)) {
      const close = source.toLowerCase().indexOf('</style', index);
      const stop = close === -1 ? source.length : close;
      result += rewriteCssReferences(source.slice(index, stop), transform);
      index = stop;
    } else if ((name === 'script' || name === 'template') && !/^<\//.test(tag)) {
      const close = source.toLowerCase().indexOf(`</${name}`, index);
      const stop = close === -1 ? source.length : close;
      result += source.slice(index, stop);
      index = stop;
    }
  }
  return result;
}

function findHtmlTagEnd(source, start) {
  let quote = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

function resolveSrcsetWithTransform(value, transform) {
  return splitSrcsetCandidates(value).map(part => {
    const trimmed = part.trim();
    if (!trimmed) return part;
    const pieces = trimmed.split(/\s+/);
    const resolved = transform(pieces[0]);
    if (!resolved || resolved === pieces[0]) return part;
    pieces[0] = resolved;
    return pieces.join(' ');
  }).join(', ');
}

function findFileByReference(hostFilename, refPath, allowedExtensions = null) {
  for (const candidatePath of getReferencePathCandidates(hostFilename, refPath)) {
    const file = files.find(item => !item.isFolder && item.name.toLowerCase() === candidatePath.toLowerCase());
    if (!file) continue;
    if (allowedExtensions && !allowedExtensions.has(getFileExtension(file.name))) continue;
    return file;
  }
  return null;
}

function injectPreviewGuardIntoHtml(htmlContent, guardStyle, guardScript) {
  let result = String(htmlContent || '');
  const payload = [guardStyle, guardScript].filter(Boolean).join('\n');
  if (!payload) return result;
  if (/<head\b[^>]*>/i.test(result)) {
    return result.replace(/<head\b[^>]*>/i, match => `${match}\n${payload}`);
  }
  if (/<html\b[^>]*>/i.test(result)) {
    return result.replace(/<html\b[^>]*>/i, match => `${match}\n<head>\n${payload}\n</head>`);
  }
  // A doctype is a document prologue, not user content to be pushed below
  // injected nodes.  Insert after it so srcdoc preserves standards mode and
  // the original source order remains observable by the page.
  const doctype = result.match(/^\s*<!doctype\b[^>]*>\s*/i);
  if (doctype) {
    return `${doctype[0]}${payload}\n${result.slice(doctype[0].length)}`;
  }
  return `${payload}\n${result}`;
}

// Every preview document gets the runtime (diagnostics, isolated storage
// and, in Files, clean URLs and project navigation) as its first script, plus
// the render token the editor uses to recognise the load it requested.
function applyNonDraggableImageGuard(htmlContent, { preventPreviewFocus = false, renderToken = '', mode = 'document' } = {}) {
  void preventPreviewFocus;
  const guardAttribute = 'data-html-viewer-runtime';
  const safeRenderToken = JSON.stringify(String(renderToken ?? '')).replace(/</g, '\\u003c');
  const guardScript = `${createPreviewRuntimeScript({ mode, renderToken })}
<script ${guardAttribute}-token>
 (() => {
   try { document.documentElement?.setAttribute('data-html-viewer-render-token', ${safeRenderToken}); } catch {}
 })();
</script>`;

  let result = String(htmlContent || '');
  if (!new RegExp(`<(?:script|style)\\b[^>]*\\b${guardAttribute}(?:\\s|=|>)`, 'i').test(result)) {
    result = injectPreviewGuardIntoHtml(result, '', guardScript);
  }
  return result;
}

function inlineCssImports(cssContent, hostFilename, dataUrlMap, seenFiles = new Set()) {
  return cssContent.replace(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*([^;]*);?/gi, (match, quote, refPath, mediaQuery) => {
    const importedFile = findFileByReference(hostFilename, refPath, new Set(['css']));
    if (!importedFile || seenFiles.has(importedFile.name)) return match;

    const nextSeen = new Set(seenFiles);
    nextSeen.add(importedFile.name);
    let importedContent = getFileText(importedFile);
    importedContent = inlineCssImports(importedContent, importedFile.name, dataUrlMap, nextSeen);
    importedContent = resolveCssUrls(importedContent, dataUrlMap, importedFile.name);

    const media = String(mediaQuery || '').trim();
    if (media) {
      return `@media ${media} {\n${importedContent}\n}`;
    }
    return importedContent;
  });
}

// Helper to resolve relative paths in HTML content to Blob URLs
function resolveVirtualPaths(content, fileMap, entryFilename) {
  if (!entryFilename) entryFilename = 'index.html';
  const transform = refPath => resolveReferenceValue(refPath, fileMap, entryFilename);
  return rewriteHtmlReferenceAttributes(content, transform);
}
