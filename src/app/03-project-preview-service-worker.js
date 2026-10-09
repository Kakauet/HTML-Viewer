function canUseProjectPreviewServiceWorker() {
  return Boolean(
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    (location.protocol === 'http:' || location.protocol === 'https:')
  );
}

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

function withTimeout(promise, timeoutMs, fallbackValue = null) {
  return new Promise(resolve => {
    const timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
    Promise.resolve(promise)
      .then(value => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timeoutId);
        resolve(fallbackValue);
      });
  });
}

function isProjectPreviewServiceWorkerScript(scriptUrl = '') {
  try {
    const url = new URL(scriptUrl, location.href);
    return url.origin === location.origin && url.pathname === new URL(PROJECT_PREVIEW_SW_URL).pathname;
  } catch {
    return String(scriptUrl || '').includes('preview-sw.js');
  }
}

function isCurrentProjectPreviewScope(scopeUrl = '') {
  try {
    const url = new URL(scopeUrl, location.href);
    return url.pathname === PROJECT_PREVIEW_SW_SCOPE;
  } catch {
    return String(scopeUrl || '').endsWith(PROJECT_PREVIEW_SW_SCOPE);
  }
}

function cleanupLegacyProjectPreviewServiceWorkers() {
  if (!canUseProjectPreviewServiceWorker()) return;
  navigator.serviceWorker.getRegistrations()
    .then(registrations => {
      registrations.forEach(registration => {
        const worker = registration.active || registration.waiting || registration.installing;
        if (!worker || !isProjectPreviewServiceWorkerScript(worker.scriptURL)) return;
        if (isCurrentProjectPreviewScope(registration.scope)) return;
        registration.unregister().catch(() => {});
      });
    })
    .catch(() => {});
}

function waitForProjectPreviewServiceWorker(registration) {
  if (registration.active) return Promise.resolve(registration.active);

  const worker = registration.installing || registration.waiting;
  if (!worker) return Promise.resolve(null);

  return new Promise(resolve => {
    const finish = () => {
      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', finish);
        resolve(registration.active || worker);
      } else if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', finish);
        resolve(null);
      }
    };
    worker.addEventListener('statechange', finish);
    finish();
  });
}

cleanupLegacyProjectPreviewServiceWorkers();

async function ensureProjectPreviewServiceWorker() {
  if (!canUseProjectPreviewServiceWorker()) return null;
  if (projectPreviewServiceWorker?.state === 'activated') return projectPreviewServiceWorker;
  projectPreviewServiceWorker = null;
  projectPreviewServiceWorkerPromise = null;

  if (!projectPreviewServiceWorkerPromise) {
    projectPreviewServiceWorkerPromise = navigator.serviceWorker.register(PROJECT_PREVIEW_SW_URL, { scope: PROJECT_PREVIEW_SW_SCOPE, updateViaCache: 'none' })
      .then(async registration => {
        registration.update?.().catch(() => {});
        const worker = await withTimeout(
          waitForProjectPreviewServiceWorker(registration),
          PROJECT_PREVIEW_SW_READY_TIMEOUT_MS,
          registration.active || null
        );
        if (!worker) {
          projectPreviewServiceWorkerPromise = null;
          return null;
        }
        projectPreviewServiceWorker = worker;
        return worker;
      })
      .catch(err => {
        void err;
        projectPreviewServiceWorker = null;
        projectPreviewServiceWorkerPromise = null;
        return null;
      });
  }

  return projectPreviewServiceWorkerPromise;
}

function postProjectPreviewMessage(message, transfer = []) {
  return new Promise((resolve, reject) => {
    const worker = projectPreviewServiceWorker;
    if (!worker) {
      reject(new Error('Service Worker no disponible'));
      return;
    }

    const channel = new MessageChannel();
    const timeoutId = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Timeout sincronizando preview'));
    }, PROJECT_PREVIEW_MESSAGE_TIMEOUT_MS);

    channel.port1.onmessage = event => {
      clearTimeout(timeoutId);
      channel.port1.close();
      const data = event.data || {};
      if (data.ok) resolve(data);
      else reject(new Error(data.error || 'Error sincronizando preview'));
    };

    worker.postMessage(message, [channel.port2, ...transfer]);
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
  const url = new URL(`${PROJECT_PREVIEW_PREFIX}/${projectPreviewSessionId}/${encodedPath}${trailingSlash}`, APP_ROOT_URL);
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
  try {
    const previewWindow = previewIframe.contentWindow;
    const href = previewWindow?.location?.href || '';
    const info = href && readPreviewRuntimeInfo(previewWindow);
    if (info?.prettyPathname) {
      const current = new URL(href);
      if (current.origin === location.origin && !getProjectPreviewPathFromUrl(current.href)) {
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
    if (!path && previewLifecycle.mode === 'project' && url.origin === location.origin) {
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
      if (url.origin === location.origin) {
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
    projectPreviewServiceWorker = null;
    projectPreviewServiceWorkerPromise = null;
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
