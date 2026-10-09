// Map to store current virtual Blob URLs
const virtualBlobUrls = {};
// Cache to store details of previously created blob URLs
// Structure: file.name -> { url, rawContent, resolvedContent, sourceBlob }
const blobUrlCache = {};

function createProjectFileLookup() {
  const lookup = new Map();
  files.forEach(file => {
    if (!file.isFolder) {
      lookup.set(normalizeProjectPath(file.name).toLowerCase(), file);
    }
  });
  return lookup;
}

function cleanupVirtualBlobUrlCache() {
  const activeFileNames = new Set(files.filter(f => !f.isFolder).map(f => f.name));

  for (const name in blobUrlCache) {
    if (!activeFileNames.has(name)) {
      URL.revokeObjectURL(blobUrlCache[name].url);
      delete blobUrlCache[name];
    }
  }

  for (const key in virtualBlobUrls) {
    if (!activeFileNames.has(key)) {
      delete virtualBlobUrls[key];
    }
  }
}

function findFileByCanonicalPath(canonicalPath, fileLookup = null) {
  const lookupPath = normalizeProjectPath(canonicalPath).toLowerCase();
  if (fileLookup) return fileLookup.get(lookupPath) || null;
  return files.find(item => !item.isFolder && item.name.toLowerCase() === lookupPath) || null;
}

function resolveReferenceValueLazy(refPath, hostFilename, resolver) {
  const { suffix } = splitPathSuffix(refPath);
  for (const candidatePath of getReferencePathCandidates(hostFilename, refPath)) {
    const resolved = resolver(candidatePath);
    if (resolved) return appendReferenceSuffix(resolved, suffix);
  }
  return null;
}

function resolveSrcsetLazy(value, hostFilename, resolver) {
  return resolveSrcsetWithTransform(value, refPath => resolveReferenceValueLazy(refPath, hostFilename, resolver));
}

function resolveCssUrlsLazy(content, hostFilename, resolver) {
  return rewriteCssReferences(content, refPath => resolveReferenceValueLazy(refPath, hostFilename, resolver));
}

function resolveVirtualPathsLazy(content, entryFilename, resolver) {
  const transform = refPath => resolveReferenceValueLazy(refPath, entryFilename, resolver);
  return rewriteHtmlReferenceAttributes(content, transform);
}

function ensureVirtualBlobUrl(file, resolving = new Set(), fileLookup = null) {
  if (!file || file.isFolder) return null;

  const cached = blobUrlCache[file.name];
  if (file.isBinary) {
    const ext = getFileExtension(file.name);
    const isFont = ['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext);
    if (isFont && file.dataUrl) {
      virtualBlobUrls[file.name] = file.dataUrl;
      return file.dataUrl;
    }
    const currentBlob = getFileBlob(file);
    if (cached && cached.sourceBlob === currentBlob) {
      virtualBlobUrls[file.name] = cached.url;
      return cached.url;
    }
    if (cached) URL.revokeObjectURL(cached.url);
    const newUrl = URL.createObjectURL(currentBlob);
    blobUrlCache[file.name] = { url: newUrl, sourceBlob: currentBlob, rawContent: null, resolvedContent: null };
    virtualBlobUrls[file.name] = newUrl;
    return newUrl;
  }

  const rawContent = getFileText(file);
  const ext = getFileExtension(file.name);

  if (resolving.has(file.name)) {
    if (cached) return cached.url;
    const cycleUrl = URL.createObjectURL(getFileBlob(file));
    blobUrlCache[file.name] = { url: cycleUrl, rawContent, resolvedContent: rawContent, sourceBlob: null };
    virtualBlobUrls[file.name] = cycleUrl;
    return cycleUrl;
  }

  resolving.add(file.name);
  const resolver = (canonicalPath) => {
    const referencedFile = findFileByCanonicalPath(canonicalPath, fileLookup);
    return ensureVirtualBlobUrl(referencedFile, resolving, fileLookup);
  };

  let resolvedContent = rawContent;
  if (ext === 'html' || ext === 'htm') {
    resolvedContent = resolveVirtualPathsLazy(rawContent, file.name, resolver);
  } else if (ext === 'css') {
    resolvedContent = resolveCssUrlsLazy(rawContent, file.name, resolver);
  }
  resolving.delete(file.name);

  if (cached && cached.rawContent === rawContent && cached.resolvedContent === resolvedContent) {
    virtualBlobUrls[file.name] = cached.url;
    return cached.url;
  }

  if (cached) URL.revokeObjectURL(cached.url);
  const newUrl = URL.createObjectURL(getFileBlob(file, resolvedContent));
  blobUrlCache[file.name] = { url: newUrl, rawContent, resolvedContent, sourceBlob: null };
  virtualBlobUrls[file.name] = newUrl;
  return newUrl;
}

// Generate Blob URLs for all virtual files
function generateBlobUrls() {
  // Identify all active file names (non-folders)
  const activeFileNames = new Set(files.filter(f => !f.isFolder).map(f => f.name));

  // Revoke and remove cache entries for files that no longer exist
  for (const name in blobUrlCache) {
    if (!activeFileNames.has(name)) {
      URL.revokeObjectURL(blobUrlCache[name].url);
      delete blobUrlCache[name];
    }
  }

  // Clear map of old keys
  for (const key in virtualBlobUrls) {
    if (!activeFileNames.has(key)) {
      delete virtualBlobUrls[key];
    }
  }

  // First pass: ensure every file has a base Blob URL in virtualBlobUrls.
  files.forEach(file => {
    if (file.isFolder) return;

    const cached = blobUrlCache[file.name];
    if (file.isBinary) {
      const ext = getFileExtension(file.name);
      const isFont = ['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext);
      if (isFont && file.dataUrl) {
        virtualBlobUrls[file.name] = file.dataUrl;
      } else {
        const currentBlob = getFileBlob(file);
        if (cached && cached.sourceBlob === currentBlob) {
          virtualBlobUrls[file.name] = cached.url;
        } else {
          if (cached) URL.revokeObjectURL(cached.url);
          const newUrl = URL.createObjectURL(currentBlob);
          blobUrlCache[file.name] = { url: newUrl, sourceBlob: currentBlob, resolvedContent: null, rawContent: null };
          virtualBlobUrls[file.name] = newUrl;
        }
      }
    } else {
      const currentRawContent = getFileText(file);
      if (cached && cached.rawContent === currentRawContent) {
        virtualBlobUrls[file.name] = cached.url;
      } else {
        // We will generate the final URL in the second pass, but we need a baseline URL
        // in virtualBlobUrls for other files to resolve. We use the cached URL if available,
        // or a new temporary one if not cached.
        if (cached) {
          virtualBlobUrls[file.name] = cached.url;
        } else {
          const tempUrl = URL.createObjectURL(getFileBlob(file));
          blobUrlCache[file.name] = { url: tempUrl, rawContent: currentRawContent, resolvedContent: null, sourceBlob: null };
          virtualBlobUrls[file.name] = tempUrl;
        }
      }
    }
  });

  // Second pass: resolve references and recreate URLs for text files if their resolved content changed.
  files.forEach(file => {
    if (file.isFolder || file.isBinary) return;

    const ext = getFileExtension(file.name);
    const rawContent = getFileText(file);

    let resolvedContent;
    if (ext === 'html' || ext === 'htm') {
      resolvedContent = resolveVirtualPaths(rawContent, virtualBlobUrls, file.name);
    } else if (ext === 'css') {
      resolvedContent = resolveCssUrls(rawContent, virtualBlobUrls, file.name);
    } else {
      resolvedContent = rawContent;
    }

    const cached = blobUrlCache[file.name];
    if (cached && cached.resolvedContent === resolvedContent && cached.rawContent === rawContent) {
      virtualBlobUrls[file.name] = cached.url;
    } else {
      if (cached) {
        URL.revokeObjectURL(cached.url);
      }
      const newBlob = getFileBlob(file, resolvedContent);
      const newUrl = URL.createObjectURL(newBlob);
      blobUrlCache[file.name] = {
        url: newUrl,
        rawContent: rawContent,
        resolvedContent: resolvedContent,
        sourceBlob: null
      };
      virtualBlobUrls[file.name] = newUrl;
    }
  });
}

function captureExportRevision() {
  return {
    projectIdentity,
    entryId: getEntryFile()?.id || '',
    files: files.map(file => ({
      ...file,
      content: file.isBinary ? '' : getFileText(file),
      blob: file.blob
    }))
  };
}

function getRevisionFileBlob(file, contentOverride = null) {
  if (file.isBinary && file.blob) return file.blob;
  const content = contentOverride !== null ? contentOverride : file.content || '';
  return new Blob([content], { type: `${file.mimeType || getMimeTypeForFilename(file.name)};charset=utf-8` });
}

async function createVirtualFileDataUrlSnapshot(sourceFiles = files) {
  const dataUrlMap = {};

  for (const file of sourceFiles) {
    if (file.isFolder) continue;
    try {
      dataUrlMap[file.name] = await blobToDataUrl(getRevisionFileBlob(file));
    } catch {
      // Leave references untouched if a browser refuses to encode a file.
    }
  }

  for (const file of sourceFiles) {
    if (file.isFolder || file.isBinary) continue;
    const ext = getFileExtension(file.name);
    if (ext !== 'html' && ext !== 'htm' && ext !== 'css') continue;

    const rawContent = file.content || '';
    const resolvedContent = ext === 'css'
      ? resolveCssUrls(rawContent, dataUrlMap, file.name)
      : resolveVirtualPaths(rawContent, dataUrlMap, file.name);

    try {
      dataUrlMap[file.name] = await blobToDataUrl(getRevisionFileBlob(file, resolvedContent));
    } catch {
      // Keep the first-pass Data URL if the rewritten version cannot be encoded.
    }
  }

  return dataUrlMap;
}

function preloadFontDataUrls() {
  let changed = false;
  const promises = files.map(file => {
    if (file.isBinary && file.blob && !file.dataUrl) {
      const ext = getFileExtension(file.name);
      const isFont = ['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext);
      if (isFont) {
        return blobToDataUrl(file.blob).then(url => {
          file.dataUrl = url;
          changed = true;
        }).catch(err => {
          console.error('Failed to convert font blob to Data URL:', err);
        });
      }
    }
    return null;
  }).filter(Boolean);

  if (promises.length > 0) {
    Promise.all(promises).then(() => {
      if (changed && typeof schedulePreviewUpdate === 'function') {
        schedulePreviewUpdate();
      }
    });
  }
}

// Initial run
preloadFontDataUrls();
