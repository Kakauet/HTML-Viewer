let projectPreviewTransport = createPreviewWorkerTransport({
  scriptUrl: PROJECT_PREVIEW_SW_URL,
  scope: PROJECT_PREVIEW_SW_SCOPE,
  readyTimeout: PROJECT_PREVIEW_SW_READY_TIMEOUT_MS,
  messageTimeout: PROJECT_PREVIEW_MESSAGE_TIMEOUT_MS
});
const canUseProjectPreviewServiceWorker = projectPreviewTransport.available;
async function ensureProjectPreviewServiceWorker() {
  if (!canUseProjectPreviewServiceWorker()) return null;
  let worker = await projectPreviewTransport.ensure();
  if (!worker && IS_REMOTE_PREVIEW) {
    // Tracking protection can block a third-party worker. Preserve project
    // playback through the existing trusted mode, with an explicit notice.
    projectPreviewTransport.reset();
    PREVIEW_ROOT_URL = APP_ROOT_URL;
    PREVIEW_ORIGIN = new URL(APP_ROOT_URL).origin;
    IS_REMOTE_PREVIEW = false;
    remotePreviewSnapshot = null;
    projectPreviewTransport = createPreviewWorkerTransport({
      scriptUrl: new URL(`preview-sw.js?v=${PROJECT_PREVIEW_SW_VERSION}`, APP_ROOT_URL).href,
      scope: PROJECT_PREVIEW_SW_SCOPE,
      readyTimeout: PROJECT_PREVIEW_SW_READY_TIMEOUT_MS,
      messageTimeout: PROJECT_PREVIEW_MESSAGE_TIMEOUT_MS
    });
    projectPreviewTransport.cleanupLegacy();
    showToast(currentLocale === 'es'
      ? 'El navegador no permite separar la vista previa. Se usa el modo compatible: abre solo proyectos de confianza.'
      : 'The browser blocked preview isolation. Compatibility mode is active: open only trusted projects.', 'info');
    worker = await projectPreviewTransport.ensure();
  }
  return worker;
}
const postProjectPreviewMessage = (message, transfer) => projectPreviewTransport.send(message, transfer);
projectPreviewTransport.cleanupLegacy();

function markProjectPreviewDirty(path = null, { all = false } = {}) {
  projectPreviewDirtySerial += 1;
  if (all || !path) {
    projectPreviewNeedsFullSync = true;
    projectPreviewFullDirtySerial = projectPreviewDirtySerial;
    projectPreviewDirtyPaths.clear();
    return;
  }

  const cleanPath = normalizeProjectPath(path);
  if (cleanPath) {
    projectPreviewDirtyPaths.set(cleanPath, projectPreviewDirtySerial);
  }
}

function yieldToMainThread() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 50 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function createProjectPreviewEntry(file, renderToken = '') {
  if (!file || file.isFolder) return null;
  const cleanPath = normalizeProjectPath(file.name);
  if (!cleanPath) return null;

  const ext = getFileExtension(cleanPath);
  const isHtml = ext === 'html' || ext === 'htm';
  // Files are served exactly as authored: the page runs at its own clean URL,
  // so relative and root-relative references resolve like on a real host.
  // HTML only gains the preview runtime as its first script.
  let content = null;
  if (!file.isBinary) {
    content = getFileText(file);
    if (isHtml) {
      content = applyNonDraggableImageGuard(content, {
        preventPreviewFocus: previewBlockFocusForCurrentRender,
        renderToken,
        mode: 'project'
      });
    }
  }

  return {
    path: cleanPath,
    mimeType: file.mimeType || getMimeTypeForFilename(cleanPath),
    isBinary: Boolean(file.isBinary),
    content,
    blob: file.isBinary ? getFileBlob(file) : null
  };
}

async function collectProjectPreviewEntries(paths = null, resourceVersion = null) {
  const selectedPaths = paths ? new Set(Array.from(paths).map(path => normalizeProjectPath(path)).filter(Boolean)) : null;
  const entries = [];
  let processed = 0;
  const fileLookup = createProjectFileLookup();

  if (selectedPaths) {
    for (const cleanPath of selectedPaths) {
      const entry = createProjectPreviewEntry(fileLookup.get(cleanPath.toLowerCase()), resourceVersion);
      if (entry) entries.push(entry);
      processed += 1;
      if (processed % 80 === 0) {
        await yieldToMainThread();
      }
    }
    return entries;
  }

  for (const file of files) {
    const entry = createProjectPreviewEntry(file, resourceVersion);
    if (!entry) continue;
    entries.push(entry);

    processed += 1;
    if (processed % 80 === 0) {
      await yieldToMainThread();
    }
  }

  return entries;
}

function getProjectPreviewUrl(path = '', version = null) {
  const cleanPath = normalizeProjectPath(path || 'index.html');
  const trailingSlash = String(path).endsWith('/') && cleanPath ? '/' : '';
  const encodedPath = cleanPath
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const url = new URL(`${PROJECT_PREVIEW_PREFIX}/${projectPreviewSessionId}/${encodedPath}${trailingSlash}`, PREVIEW_ROOT_URL);
  if (version !== null && version !== undefined) {
    url.searchParams.set(PROJECT_PREVIEW_VERSION_PARAM, String(version));
  }
  return url.href;
}

function getProjectPreviewPathFromUrl(urlValue) {
  try {
    const url = new URL(urlValue, location.href);
    const marker = `${PROJECT_PREVIEW_SW_SCOPE}${projectPreviewSessionId}/`;
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex === -1) return '';

    const encodedPath = url.pathname.slice(markerIndex + marker.length);
    return normalizeProjectPath(decodeURIComponent(encodedPath));
  } catch {
    return '';
  }
}

// A page served by the preview worker shows its published URL
// (`/servicios/x`); everything else in the editor reasons about the worker
// URL that served it. Only primitive values are read from the page.
function readPreviewRuntimeInfo(previewWindow) {
  if (IS_REMOTE_PREVIEW) return remotePreviewSnapshot?.runtime || null;
  try {
    const info = previewWindow?.__htmlViewerPreview;
    if (!info || info.session !== projectPreviewSessionId) return null;
    const fields = ['siteRoot', 'version', 'sourceHref', 'prettyPathname'];
    if (!fields.every(field => typeof info[field] === 'string')) return null;
    return { siteRoot: info.siteRoot, version: info.version, sourceHref: info.sourceHref, prettyPathname: info.prettyPathname };
  } catch {
    return null;
  }
}

// Project path for a published-style (root-relative) URL path.
function getProjectPathFromSitePathname(pathname, siteRoot = getProjectPreviewSiteRootPath()) {
  const decoded = decodeUrlPathComponent(pathname);
  return normalizeProjectPath(siteRoot ? `${siteRoot}/${decoded}` : decoded, { folder: decoded.endsWith('/') });
}

function getProjectPreviewUrlForSiteUrl(urlValue, version = null, siteRoot = getProjectPreviewSiteRootPath()) {
  const url = new URL(urlValue, location.href);
  const target = new URL(getProjectPreviewUrl(getProjectPathFromSitePathname(url.pathname, siteRoot) || `${siteRoot}/`));
  target.search = url.search;
  target.hash = url.hash;
  if (version !== null && version !== undefined && version !== '') {
    target.searchParams.set(PROJECT_PREVIEW_VERSION_PARAM, String(version));
  }
  return target.href;
}

function getPreviewIframeUrl() {
  if (!previewIframe) return '';
  if (!previewIframe.getAttribute('sandbox')?.includes('allow-same-origin')) return previewIframe.src || '';
  if (IS_REMOTE_PREVIEW && previewLifecycle.mode === 'project') {
    return remotePreviewSnapshot?.sourceUrl || previewLifecycle.expectedNavigation?.url || previewIframe.src || '';
  }
  try {
    const previewWindow = previewIframe.contentWindow;
    const href = previewWindow?.location?.href || '';
    const info = href && readPreviewRuntimeInfo(previewWindow);
    if (info?.prettyPathname) {
      const current = new URL(href);
      if (current.origin === PREVIEW_ORIGIN && !getProjectPreviewPathFromUrl(current.href)) {
        if (current.pathname === info.prettyPathname) {
          // Same page as served: keep the exact worker URL (`index.html`).
          const source = new URL(info.sourceHref);
          source.search = current.search;
          source.searchParams.set(PROJECT_PREVIEW_VERSION_PARAM, info.version);
          source.hash = current.hash;
          return source.href;
        }
        // The page changed its own route (pushState).
        return getProjectPreviewUrlForSiteUrl(current.href, info.version, info.siteRoot);
      }
    }
    return href || previewIframe.src || '';
  } catch {
    return previewIframe.src || '';
  }
}

function setProjectPreviewLocation(urlValue, fallbackPath = '') {
  let path = normalizeProjectPath(fallbackPath || '');
  let search = '';
  let hash = '';
  try {
    const url = new URL(urlValue, location.href);
    path = getProjectPreviewPathFromUrl(url.href) || path;
    if (!path && previewLifecycle.mode === 'project' && url.origin === PREVIEW_ORIGIN) {
      path = getProjectPathFromSitePathname(url.pathname);
    }
    search = url.search;
    hash = url.hash;
  } catch {}

  if (!path) return false;
  previewLifecycle.projectPath = path;
  previewLifecycle.projectSearch = search;
  previewLifecycle.projectHash = hash;
  return true;
}

function resetProjectPreviewLocation() {
  previewLifecycle.projectPath = '';
  previewLifecycle.projectSearch = '';
  previewLifecycle.projectHash = '';
}

// `dist/index.html`, `dist/` and `dist` are all the entry page.
function isEntryProjectPreviewPath(path) {
  const entryFile = getEntryFile();
  const cleanPath = normalizeProjectPath(path);
  if (!entryFile || !cleanPath) return false;
  if (cleanPath.toLowerCase() === normalizeProjectPath(entryFile.name).toLowerCase()) return true;
  return findProjectFileByStaticRoute(cleanPath)?.id === entryFile.id && !/\.[^/.]+$/.test(cleanPath.split('/').pop() || '');
}

// The route the page would have when published, e.g. `/servicios/tasaciones`.
function getProjectPreviewSiteRoute(path) {
  const cleanPath = normalizeProjectPath(path);
  const siteRoot = getProjectPreviewSiteRootPath();
  const inSite = siteRoot && cleanPath.toLowerCase().startsWith(`${siteRoot.toLowerCase()}/`)
    ? cleanPath.slice(siteRoot.length + 1)
    : (cleanPath.toLowerCase() === siteRoot.toLowerCase() ? '' : cleanPath);
  return `/${inSite.replace(/(^|\/)index\.html?$/i, '$1')}`;
}

function getPreviewSitePathLabel(path) {
  const route = getProjectPreviewSiteRoute(path);
  return route.length > 42 ? `…${route.slice(-41)}` : route;
}

function getCompactPreviewPath(path) {
  const cleanPath = normalizeProjectPath(path);
  if (!cleanPath) return '';
  const parts = cleanPath.split('/').filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : cleanPath;
}

function isKnownProjectPreviewPath(path) {
  if (findProjectFileByStaticRoute(path)) return true;
  const cleanPath = normalizeProjectPath(path);
  const lastSegment = cleanPath.split('/').pop() || '';
  const isExtensionlessRoute = Boolean(cleanPath) && !/\.[^/.]+$/.test(lastSegment);
  const hasCustomNotFound = Boolean(findProjectFileByStaticRoute('404.html', { preferSiteRoot: true }));
  return Boolean(isExtensionlessRoute && !hasCustomNotFound && getEntryFile());
}

function syncProjectPreviewNavigationState({ preferExpected = true } = {}) {
  if (!previewIframe) return false;

  const expected = previewLifecycle.expectedNavigation;
  if (
    preferExpected &&
    expected?.mode === 'project' &&
    expected.generation === previewLifecycle.generation &&
    expected.path
  ) {
    setProjectPreviewLocation(expected.url, expected.path);
    return true;
  }

  const currentUrl = getPreviewIframeUrl();
  // A frame that is between documents has no location of its own yet.
  if (!currentUrl) return false;
  let currentPath = getProjectPreviewPathFromUrl(currentUrl);
  if (!currentPath && previewLifecycle.mode === 'project') {
    try {
      const url = new URL(currentUrl, location.href);
      if (url.origin === PREVIEW_ORIGIN) {
        currentPath = getProjectPathFromSitePathname(url.pathname);
      }
    } catch {}
  }
  if (!currentPath) return false;

  const previousMissingPath = projectPreviewMissingPath;
  setProjectPreviewLocation(currentUrl, currentPath);

  if (!isKnownProjectPreviewPath(currentPath)) {
    projectPreviewMissingPath = currentPath;
    setPreviewStatus(`${PREVIEW_NOT_FOUND_LABEL}: ${getCompactPreviewPath(currentPath)}`, 'error');
  } else {
    projectPreviewMissingPath = '';
    projectPreviewNotifiedMissingPath = '';
    const label = isEntryProjectPreviewPath(currentPath)
      ? PREVIEW_READY_LABEL
      : `${t('preview_viewing')}: ${getPreviewSitePathLabel(currentPath)}`;
    setPreviewStatus(label, 'ready');
  }

  if (previousMissingPath !== projectPreviewMissingPath && editorMode === 'split') {
    renderFileExplorer();
  }
  return true;
}

function clearSyncedProjectPreviewDirtyState(dirtyEntriesAtStart, dirtySerialAtStart, fullDirtySerialAtStart) {
  dirtyEntriesAtStart.forEach(([path, serial]) => {
    if (projectPreviewDirtyPaths.get(path) === serial) {
      projectPreviewDirtyPaths.delete(path);
    }
  });
  if (projectPreviewFullDirtySerial === fullDirtySerialAtStart && projectPreviewFullDirtySerial <= dirtySerialAtStart) {
    projectPreviewNeedsFullSync = false;
  }
}

async function syncProjectPreviewSnapshot(options = {}) {
  if (options.full) {
    markProjectPreviewDirty(null, { all: true });
  }

  const queuedSync = projectPreviewSyncQueue
    .catch(() => false)
    .then(() => syncProjectPreviewSnapshotNow({ requestId: options.requestId ?? null }));

  projectPreviewSyncQueue = queuedSync.catch(() => false);
  return queuedSync;
}

async function syncProjectPreviewSnapshotNow({ requestId = null, staleRetryCount = 0 } = {}) {
  try {
    if (requestId !== null && requestId !== previewLifecycle.generation) return false;
    const generationAtStart = previewLifecycle.sessionGeneration;
    const sessionIdAtStart = projectPreviewSessionId;
    const worker = await ensureProjectPreviewServiceWorker();
    if (
      !worker ||
      generationAtStart !== previewLifecycle.sessionGeneration ||
      (requestId !== null && requestId !== previewLifecycle.generation)
    ) return false;

    const dirtySerialAtStart = projectPreviewDirtySerial;
    const fullDirtySerialAtStart = projectPreviewFullDirtySerial;
    const dirtyEntriesAtStart = Array.from(projectPreviewDirtyPaths.entries());
    const activePaths = new Set(files.filter(file => !file.isFolder).map(file => normalizeProjectPath(file.name)));
    const nextSiteRoot = getProjectPreviewSiteRootPath();
    const removedPaths = [];
    for (const knownPath of projectPreviewKnownPaths) {
      if (!activePaths.has(knownPath)) {
        removedPaths.push(knownPath);
      }
    }
    const addedPaths = [];
    for (const activePath of activePaths) {
      if (!projectPreviewKnownPaths.has(activePath)) {
        addedPaths.push(activePath);
      }
    }

    const siteRootChanged = nextSiteRoot !== projectPreviewSiteRoot;
    let needsFull = siteRootChanged || projectPreviewNeedsFullSync || projectPreviewKnownPaths.size === 0;
    let dirtyPaths = needsFull ? activePaths : new Set();
    if (!needsFull) {
      dirtyEntriesAtStart.forEach(([path]) => {
        if (activePaths.has(path)) dirtyPaths.add(path);
      });
      addedPaths.forEach(path => dirtyPaths.add(path));
    }

    if (!needsFull && dirtyPaths.size === 0 && removedPaths.length === 0) {
      const sessionState = await postProjectPreviewMessage({
        type: 'html-viewer:touch-project',
        sessionId: sessionIdAtStart
      });
      if (
        generationAtStart !== previewLifecycle.sessionGeneration ||
        sessionIdAtStart !== projectPreviewSessionId ||
        (requestId !== null && requestId !== previewLifecycle.generation)
      ) {
        return false;
      }

      const remoteVersion = Number(sessionState.version) || 0;
      if (sessionState.found && remoteVersion === projectPreviewVersion) {
        clearSyncedProjectPreviewDirtyState(dirtyEntriesAtStart, dirtySerialAtStart, fullDirtySerialAtStart);
        return true;
      }

      // The browser may terminate the worker while the editor is in the
      // background. If its persisted snapshot was also evicted or expired,
      // rebuild the complete project before following the next link.
      projectPreviewIssuedVersion = Math.max(projectPreviewIssuedVersion, remoteVersion);
      projectPreviewNeedsFullSync = true;
      needsFull = true;
      dirtyPaths = activePaths;
    }

    const nextVersion = Math.max(projectPreviewIssuedVersion, projectPreviewVersion) + 1;
    projectPreviewIssuedVersion = nextVersion;
    const entries = await collectProjectPreviewEntries(dirtyPaths, nextVersion);
    if (
      generationAtStart !== previewLifecycle.sessionGeneration ||
      sessionIdAtStart !== projectPreviewSessionId ||
      (requestId !== null && requestId !== previewLifecycle.generation)
    ) {
      return false;
    }
    const acknowledgement = await postProjectPreviewMessage({
      type: 'html-viewer:set-project',
      sessionId: sessionIdAtStart,
      version: nextVersion,
      siteRoot: nextSiteRoot,
      full: needsFull,
      entries,
      removedPaths
    });
    if (
      generationAtStart !== previewLifecycle.sessionGeneration ||
      sessionIdAtStart !== projectPreviewSessionId ||
      (requestId !== null && requestId !== previewLifecycle.generation)
    ) {
      return false;
    }

    if (acknowledgement.missing) {
      projectPreviewIssuedVersion = Math.max(projectPreviewIssuedVersion, Number(acknowledgement.version) || 0);
      projectPreviewNeedsFullSync = true;
      if (staleRetryCount < 1 && (requestId === null || requestId === previewLifecycle.generation)) {
        return syncProjectPreviewSnapshotNow({ requestId, staleRetryCount: staleRetryCount + 1 });
      }
      return false;
    }

    if (acknowledgement.stale || Number(acknowledgement.version) !== nextVersion) {
      projectPreviewIssuedVersion = Math.max(projectPreviewIssuedVersion, Number(acknowledgement.version) || 0);
      projectPreviewNeedsFullSync = true;
      if (staleRetryCount < 1 && (requestId === null || requestId === previewLifecycle.generation)) {
        return syncProjectPreviewSnapshotNow({ requestId, staleRetryCount: staleRetryCount + 1 });
      }
      return false;
    }

    projectPreviewVersion = nextVersion;
    if (generationAtStart !== previewLifecycle.sessionGeneration) {
      projectPreviewNeedsFullSync = true;
      return false;
    }
    projectPreviewSiteRoot = nextSiteRoot;
    projectPreviewKnownPaths = activePaths;
    clearSyncedProjectPreviewDirtyState(dirtyEntriesAtStart, dirtySerialAtStart, fullDirtySerialAtStart);
    return true;
  } catch {
    projectPreviewTransport.reset();
    projectPreviewNeedsFullSync = true;
    if (staleRetryCount < 1 && (requestId === null || requestId === previewLifecycle.generation)) {
      return syncProjectPreviewSnapshotNow({ requestId, staleRetryCount: staleRetryCount + 1 });
    }
    return false;
  }
}

let projectPreviewResumeSyncPromise = null;

function refreshProjectPreviewAfterResume() {
  if (
    document.hidden ||
    editorMode !== 'split' ||
    previewLifecycle.mode !== 'project' ||
    !getEntryFile() ||
    projectPreviewResumeSyncPromise
  ) return;

  projectPreviewResumeSyncPromise = syncProjectPreviewSnapshot()
    .catch(() => false)
    .finally(() => {
      projectPreviewResumeSyncPromise = null;
    });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshProjectPreviewAfterResume();
});
window.addEventListener('pageshow', refreshProjectPreviewAfterResume);
