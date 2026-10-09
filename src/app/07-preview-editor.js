// Simple documents run in an opaque origin: they cannot reach the editor, its
// storage or its databases. Files previews need the editor's origin because
// only same-origin clients can be served by the preview service worker; their
// runtime scopes storage and keeps navigation inside the project instead.
function setPreviewFrameIsolation(sameOrigin) {
  if (!previewIframe) return;
  const sandbox = sameOrigin ? `${PREVIEW_SANDBOX_TOKENS} allow-same-origin` : PREVIEW_SANDBOX_TOKENS;
  if (previewIframe.getAttribute('sandbox') !== sandbox) previewIframe.setAttribute('sandbox', sandbox);
}

// Messages the preview runtime sends about the user's interaction with the
// page. They are only trusted from the iframe's current document.
function handlePreviewControlMessage(event) {
  const message = event.data;
  if (
    !message ||
    message.channel !== 'html-viewer-preview-control' ||
    !previewIframe ||
    event.source !== previewIframe.contentWindow
  ) return;

  if (message.type === 'interaction') {
    previewLastUserInteractionAt = performance.now();
    previewShouldRestoreEditorFocus = false;
  } else if (message.type === 'navigate') {
    if (editorMode === 'split' && previewLifecycle.mode === 'project' && typeof message.target === 'string') {
      navigatePreviewFromUserAction(message.target, { reason: message.recover ? 'recover' : 'link' });
    }
  } else if (message.type === 'location') {
    if (editorMode !== 'split' || previewLifecycle.mode !== 'project' || previewLifecycle.expectedNavigation) return;
    if (syncProjectPreviewNavigationState({ preferExpected: false })) {
      const entryPath = normalizeProjectPath(getEntryFile()?.name || '');
      setPreviewAwayFromHome(!isEntryProjectPreviewPath(previewLifecycle.projectPath || entryPath));
    }
  } else if (message.type === 'storage') {
    if (previewLifecycle.mode === 'srcdoc') writePreviewDocumentStorage(message);
  }
}

// Blob URLs belong to the editor's origin; an opaque document cannot load
// them, so a Simple document that uses project files keeps that origin.
let previewCodeUsesEditorBlobs = false;
function trackEditorBlobUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) previewCodeUsesEditorBlobs = true;
  return url;
}

// Helper to get the current code to be rendered in the preview
function getCurrentPreviewCode() {
  previewCodeUsesEditorBlobs = false;
  if (!editor) return '';
  const rawContent = editorMode === 'unified'
    ? getCurrentEditorDocumentText()
    : (monacoLoaded && editor.getModel?.() ? editor.getModel().getValue() : fallbackTextarea.value);
  
  if (editorMode === 'unified') {
    let entryFile = getEntryFile();
    if (entryFile && (cameFromSplitMode || files.length > 1)) {
      cleanupVirtualBlobUrlCache();
      for (const key in virtualBlobUrls) {
        delete virtualBlobUrls[key];
      }

      const fileLookup = createProjectFileLookup();
      const resolver = (canonicalPath) => {
        const referencedFile = findFileByCanonicalPath(canonicalPath, fileLookup);
        return trackEditorBlobUrl(ensureVirtualBlobUrl(referencedFile, new Set([entryFile.name]), fileLookup));
      };

      // Resolve paths inside the editor HTML using entryFile name as context
      return resolveVirtualPathsLazy(rawContent, entryFile.name, resolver);
    }
    return rawContent;
  } else {
    // Find the main HTML file: index.html, or first HTML file, or first file
    let entryFile = getEntryFile();

    if (!entryFile) return createEmptyProjectPreviewCode();

    cleanupVirtualBlobUrlCache();
    for (const key in virtualBlobUrls) {
      delete virtualBlobUrls[key];
    }

    const rawContent = getFileText(entryFile);
    const fileLookup = createProjectFileLookup();
    const resolver = (canonicalPath) => {
      const referencedFile = findFileByCanonicalPath(canonicalPath, fileLookup);
      return trackEditorBlobUrl(ensureVirtualBlobUrl(referencedFile, new Set([entryFile.name]), fileLookup));
    };

    // Resolve paths inside the entry HTML
    return resolveVirtualPathsLazy(rawContent, entryFile.name, resolver);
  }
}

function setPreviewAwayFromHome(isAway) {
  previewLifecycle.isAwayFromHome = Boolean(isAway);
  const button = document.getElementById('btn-preview-home');
  if (!button) return;
  button.disabled = !previewLifecycle.isAwayFromHome;
  button.setAttribute('aria-disabled', String(!previewLifecycle.isAwayFromHome));
}

function markPreviewHomeNavigationPending() {
  previewLifecycle.homeNavigationPending = true;
  setPreviewAwayFromHome(false);
}

function getPreviewDocumentRenderToken() {
  try {
    return previewIframe?.contentDocument?.documentElement?.getAttribute('data-html-viewer-render-token') || '';
  } catch {
    return '';
  }
}

function previewUrlsMatch(actualValue, expectedValue) {
  try {
    const actual = new URL(actualValue, location.href);
    const expected = new URL(expectedValue, location.href);
    actual.hash = '';
    expected.hash = '';
    return actual.href === expected.href;
  } catch {
    return String(actualValue || '') === String(expectedValue || '');
  }
}

function isExpectedPreviewLoad(expectation, currentUrl, currentToken) {
  if (!expectation) return false;
  if (expectation.mode === 'project') {
    if (previewUrlsMatch(currentUrl, expectation.url)) return true;
    try {
      const current = new URL(currentUrl, location.href);
      const expected = new URL(expectation.url, location.href);
      return Boolean(
        getProjectPreviewPathFromUrl(current.href) &&
        getProjectPreviewPathFromUrl(expected.href) &&
        current.searchParams.get(PROJECT_PREVIEW_VERSION_PARAM) === String(expectation.token)
      );
    } catch {
      return false;
    }
  }
  if (currentToken && currentToken === String(expectation.token)) return true;
  // document.open()/document.write() may replace <html> and remove the
  // injected marker. srcdoc plus the current generation still identify the
  // latest request, so accepting this load cannot revive an older render.
  return Boolean(
    !currentToken &&
    expectation.generation === previewLifecycle.generation &&
    previewLifecycle.mode === 'srcdoc' &&
    previewIframe?.hasAttribute('srcdoc')
  );
}

function handlePreviewFrameLoad() {
  clearTimeout(renderingTimeoutId);
  const currentUrl = getPreviewIframeUrl();
  const currentToken = getPreviewDocumentRenderToken();
  const expectation = previewLifecycle.expectedNavigation;

  // A superseded navigation can still emit load after a newer src/srcdoc has
  // already been assigned. It must not confirm navigation state or focus.
  if (expectation && !isExpectedPreviewLoad(expectation, currentUrl, currentToken)) {
    return;
  }

  // location.assign(), meta refreshes and native GET forms can target a
  // root-relative URL outside the SW scope. Move same-origin project
  // navigations back under the virtual project URL exactly once.
  if (!expectation && ensureProjectPreviewNavigationScope(currentUrl)) return;

  const isProjectPreview = syncProjectPreviewNavigationState({ preferExpected: false });
  if (expectation) {
    previewLifecycle.expectedNavigation = null;
    previewLifecycle.homeNavigationPending = false;
    previewLifecycle.phase = 'idle';
  }

  if (isProjectPreview) {
    try {
      const loadedUrl = new URL(currentUrl, location.href);
      if (Number(loadedUrl.searchParams.get(PROJECT_PREVIEW_VERSION_PARAM)) === projectPreviewVersion) {
        loadedUrl.hash = '';
        projectPreviewLastUrl = loadedUrl.href;
        lastPreviewCode = `project:${previewLifecycle.projectPath}:${projectPreviewVersion}`;
        previewLifecycle.mode = 'project';
        previewLifecycle.activeDiagnosticToken = String(projectPreviewVersion);
      }
    } catch {}
    const entryPath = normalizeProjectPath(getEntryFile()?.name || '').toLowerCase();
    const currentPath = normalizeProjectPath(previewLifecycle.projectPath || '').toLowerCase();
    setPreviewAwayFromHome(Boolean(currentPath && currentPath !== entryPath));
  } else if (
    (expectation && expectation.mode === 'srcdoc') ||
    (currentToken && currentToken === String(previewLifecycle.committedGeneration))
  ) {
    setPreviewAwayFromHome(false);
    setPreviewStatus(PREVIEW_READY_LABEL, 'ready');
  } else {
    // A non-project document without the current render token was reached by
    // the previewed page itself (including a cross-origin destination).
    setPreviewAwayFromHome(true);
  }

  restoreEditorFocusAfterPreviewLoad();
}

function ensureProjectPreviewNavigationScope(currentUrl) {
  if (!currentUrl || editorMode !== 'split' || previewLifecycle.mode !== 'project') return false;
  let current;
  try {
    current = new URL(currentUrl, location.href);
  } catch {
    return false;
  }
  if (current.origin !== location.origin || getProjectPreviewPathFromUrl(current.href)) return false;

  const navigationUrl = getCompatiblePreviewNavigationUrl(current.href);
  if (!navigationUrl || previewUrlsMatch(navigationUrl, current.href)) return false;
  const path = getProjectPathFromSitePathname(current.pathname);
  previewLifecycle.expectedNavigation = {
    mode: 'project',
    url: navigationUrl,
    path,
    token: String(projectPreviewVersion),
    generation: previewLifecycle.generation,
    reason: 'project-route'
  };
  setProjectPreviewLocation(navigationUrl, path);
  navigatePreviewFrameToUrl(navigationUrl);
  return true;
}

function initPreviewLifecycle() {
  if (!previewIframe || previewLifecycle.initialized) return;
  previewLifecycle.initialized = true;
  window.addEventListener('message', handlePreviewControlMessage);
  previewIframe.addEventListener('load', handlePreviewFrameLoad);
  prunePreviewStorageNamespaces();
  setPreviewFrameIsolation(false);

  const initialToken = 'initial';
  const initialPreviewCode = applyNonDraggableImageGuard(
    createEmptyProjectPreviewCode(''),
    { renderToken: initialToken }
  );
  previewLifecycle.expectedNavigation = { mode: 'srcdoc', token: initialToken, generation: 0, reason: 'initial' };
  previewLifecycle.activeDiagnosticToken = initialToken;
  previewLifecycle.phase = 'navigating';
  previewIframe.classList.add('is-empty');
  previewIframe.removeAttribute('src');
  previewIframe.srcdoc = initialPreviewCode;
}

function navigatePreviewFromUserAction(urlValue, { reason = 'navigation' } = {}) {
  const navigationUrl = getCompatiblePreviewNavigationUrl(urlValue);
  let destination;
  try {
    destination = new URL(navigationUrl, getPreviewIframeUrl() || location.href);
  } catch {
    return false;
  }

  const isProjectDestination = editorMode === 'split' && destination.origin === location.origin;
  if (isProjectDestination) {
    const targetPath = getProjectPreviewPathFromUrl(destination.href) || getProjectPathFromSitePathname(destination.pathname);
    setProjectPreviewLocation(destination.href, targetPath);
    setPreviewAwayFromHome(true);
    schedulePreviewUpdate({
      force: true,
      forceNavigation: true,
      reason,
      targetPath,
      targetUrl: destination.href
    });
    return true;
  }

  invalidatePreviewLifecycle(reason, { preserveLocation: true });
  setPreviewAwayFromHome(true);
  try {
    previewIframe.contentWindow.location.replace(destination.href);
  } catch {
    previewIframe.removeAttribute('srcdoc');
    previewIframe.src = destination.href;
  }
  return true;
}

function getCompatiblePreviewNavigationUrl(urlValue) {
  let destination;
  try {
    destination = new URL(urlValue, getPreviewIframeUrl() || location.href);
  } catch {
    return String(urlValue || '');
  }
  if (editorMode !== 'split' || destination.origin !== location.origin) return destination.href;
  if (getProjectPreviewPathFromUrl(destination.href)) return destination.href;
  // A published-style URL such as `/servicios/x` is relative to the site root.
  return getProjectPreviewUrlForSiteUrl(destination.href, projectPreviewVersion);
}

function returnPreviewToHome() {
  if (!editor || !previewIframe) return;
  if (previewLifecycle.homeNavigationPending || !previewLifecycle.isAwayFromHome) return;
  projectPreviewMissingPath = '';
  projectPreviewNotifiedMissingPath = '';
  markPreviewHomeNavigationPending();
  schedulePreviewUpdate({
    force: true,
    forceNavigation: true,
    reason: 'home',
    targetPath: normalizeProjectPath(getEntryFile()?.name || '')
  });
}

initPreviewLifecycle();

// Filename auto-sizing helper
function adjustFilenameWidth() {
  if (!filenameInput) return;
  const charCount = filenameInput.value.length || 1;
  filenameInput.style.width = `${charCount}ch`;
}

if (filenameInput) {
  filenameInput.addEventListener('input', adjustFilenameWidth);
  // Initial run
  adjustFilenameWidth();
}

function setPreviewStatus(label, state = 'idle') {
  if (!previewStatus) return;
  previewStatus.textContent = String(label || '');
  previewStatus.dataset.state = state;
  previewStatus.classList.toggle('is-error', state === 'error');
  previewStatus.classList.toggle('is-busy', state === 'rendering' || state === 'syncing');
  previewStatus.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');
}

function getEmptyPreviewColors() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  return isDark
    ? { background: '#0b0d13', text: '#94a3b8', title: '#e2e8f0', accent: '#8842FD', ring: 'rgba(136,66,253,.14)' }
    : { background: '#ffffff', text: '#64748b', title: '#0f172a', accent: '#7334ec', ring: 'rgba(136,66,253,.10)' };
}

// An empty message renders the default "start here" hint; a specific
// message (e.g. an empty project) is shown on its own.
function createEmptyProjectPreviewCode(message = EMPTY_PROJECT_PREVIEW_MESSAGE) {
  const { background, text, title, accent, ring } = getEmptyPreviewColors();
  const escape = value => String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
  const content = message
    ? `<p class="hint">${escape(message)}</p>`
    : `<div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg></div><p class="title">${escape(t('preview_empty_title'))}</p><p class="hint">${escape(t('preview_empty_hint'))}</p>`;

  return `<!doctype html>
<html data-html-viewer-empty-preview>
<head>
<meta charset="utf-8">
<style>
html,body{min-height:100%;height:100%;margin:0;background:${background};color:${text};}
body{display:grid;place-items:center;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;}
main{max-width:320px;padding:24px;text-align:center;}
.mark{display:inline-grid;place-items:center;width:44px;height:44px;margin-bottom:14px;border-radius:12px;background:${ring};color:${accent};}
.title{margin:0 0 6px;color:${title};font-size:15px;font-weight:600;}
.hint{margin:0;}
</style>
</head>
<body><main>${content}</main></body>
</html>`;
}

function isEmptyPreviewCode(rawCode) {
  if (!rawCode || !rawCode.trim()) return true;
  return /<html\b[^>]*\bdata-html-viewer-empty-preview(?:\s|=|>)/i.test(String(rawCode));
}

function editorHasKeyboardFocus() {
  if (monacoLoaded && editor && typeof editor.hasTextFocus === 'function') {
    return editor.hasTextFocus();
  }
  return document.activeElement === fallbackTextarea;
}

function restoreEditorFocusAfterPreviewLoad() {
  if (!previewShouldRestoreEditorFocus) return;
  previewShouldRestoreEditorFocus = false;
  const scheduledAt = performance.now();
  const restore = () => {
    if (!editor) return;
    if (previewLastUserInteractionAt >= scheduledAt) return;
    // Only recover focus the preview load took away; never pull it back from
    // a control the user moved to meanwhile (explorer, toolbar, dialogs...).
    const active = document.activeElement;
    if (active && active !== document.body && active !== previewIframe && !editorHasKeyboardFocus()) return;
    if (monacoLoaded && typeof editor.focus === 'function') {
      editor.focus();
    } else if (fallbackTextarea) {
      fallbackTextarea.focus({ preventScroll: true });
    }
  };
  requestAnimationFrame(restore);
  setTimeout(restore, 80);
}

function getPreviewFocusPolicyForRender() {
  const hadEditorFocus = editorHasKeyboardFocus();
  return {
    // Never modify the rendered application's focus APIs or input events.
    // The parent restores editor focus after the document load instead.
    blockFocus: false,
    restoreFocus: hadEditorFocus
  };
}

function updateEditorPlaceholder() {
  if (!editorPlaceholder || !editor) return;
  if (!monacoLoaded && fallbackTextarea?.style.display === 'block') {
    scheduleFallbackEditorChromeSync();
    editorPlaceholder.classList.add('hidden');
    return;
  }

  if (editorMode === 'split' && !activeFileId) {
    editorPlaceholder.classList.remove('hidden');
    editorPlaceholder.textContent = t('placeholder_open_file');
    return;
  }

  if (editorMode === 'split') {
    const activeFile = files.find(f => f.id === activeFileId);
    if (activeFile && !isEditableFile(activeFile)) {
      editorPlaceholder.classList.add('hidden');
      return;
    }
  }

  const code = monacoLoaded ? editor.getValue() : fallbackTextarea.value;
  const hasCode = code.trim().length > 0;
  editorPlaceholder.classList.toggle('hidden', hasCode);

  if (!hasCode) {
    if (editorMode === 'unified') {
      editorPlaceholder.textContent = t('placeholder_html');
    } else {
      const file = files.find(f => f.id === activeFileId);
      if (file) {
        const ext = getFileExtension(file.name);
        if (ext === 'html' || ext === 'htm') editorPlaceholder.textContent = t('placeholder_html');
        else if (ext === 'css') editorPlaceholder.textContent = t('placeholder_css');
        else if (ext === 'js' || ext === 'jsx') editorPlaceholder.textContent = t('placeholder_js');
        else if (ext === 'json') editorPlaceholder.textContent = t('placeholder_json');
        else if (ext === 'md') editorPlaceholder.textContent = t('placeholder_md');
        else editorPlaceholder.textContent = t('placeholder_code');
      }
    }
  }
}

let previewDebounceTimeout = null;

function getPreviewDebounceMs(force = false) {
  if (force) return 0;
  if (editorMode === 'unified') return 0;

  const fileCount = files.filter(file => !file.isFolder).length;
  if (fileCount > 1200) return PROJECT_PREVIEW_DEBOUNCE_MAX_MS;
  if (fileCount > 350) return 420;
  if (fileCount > 80) return 240;
  return PROJECT_PREVIEW_DEBOUNCE_MIN_MS;
}

function createPreviewRenderRequest({
  forceNavigation = false,
  fullSync = false,
  reason = 'update',
  targetPath = '',
  targetUrl = ''
} = {}) {
  const normalizedTargetPath = normalizeProjectPath(targetPath || '');
  if (targetUrl || normalizedTargetPath) {
    setProjectPreviewLocation(targetUrl, normalizedTargetPath);
  }
  return {
    id: ++previewLifecycle.generation,
    forceNavigation: Boolean(forceNavigation),
    fullSync: Boolean(fullSync),
    reason,
    targetPath: normalizedTargetPath,
    targetUrl: String(targetUrl || ''),
    currentPath: normalizeProjectPath(previewLifecycle.projectPath || ''),
    currentSearch: previewLifecycle.projectSearch,
    currentHash: previewLifecycle.projectHash
  };
}

function isCurrentPreviewRequest(requestOrId) {
  const id = typeof requestOrId === 'object' ? requestOrId?.id : requestOrId;
  return Number(id) === previewLifecycle.generation;
}

function cancelScheduledPreviewWork() {
  if (previewFrameRequest) {
    cancelAnimationFrame(previewFrameRequest);
    previewFrameRequest = 0;
  }
  if (previewDebounceTimeout) {
    clearTimeout(previewDebounceTimeout);
    previewDebounceTimeout = null;
  }
}

function invalidatePreviewLifecycle(reason = 'invalidate', { preserveLocation = false } = {}) {
  previewLifecycle.generation += 1;
  cancelScheduledPreviewWork();
  previewLifecycle.scheduledRequest = null;
  previewLifecycle.expectedNavigation = null;
  previewLifecycle.homeNavigationPending = false;
  previewLifecycle.phase = reason;
  lastPreviewCode = '';
  projectPreviewLastUrl = '';
  if (!preserveLocation) resetProjectPreviewLocation();
}

function schedulePreviewUpdate({
  force = false,
  forceNavigation = false,
  fullSync = false,
  reason = 'update',
  targetPath = '',
  targetUrl = ''
} = {}) {
  cancelScheduledPreviewWork();
  if (editorMode === 'split' && previewLifecycle.mode === 'project' && !targetUrl && !targetPath) {
    syncProjectPreviewNavigationState();
  }
  const request = createPreviewRenderRequest({ forceNavigation, fullSync, reason, targetPath, targetUrl });
  previewLifecycle.scheduledRequest = request;
  previewLifecycle.phase = 'scheduled';

  if (force) {
    renderPreviewNow(request);
    return request.id;
  }

  // Simple remains debounce-free. Multiple changes inside one paint are
  // collapsed into the newest generation so the browser never constructs
  // documents that cannot be displayed.
  if (editorMode === 'unified') {
    previewFrameRequest = requestAnimationFrame(() => {
      previewFrameRequest = 0;
      renderPreviewNow(request);
    });
    return request.id;
  }

  previewDebounceTimeout = setTimeout(() => {
    previewDebounceTimeout = null;
    previewFrameRequest = requestAnimationFrame(() => {
      previewFrameRequest = 0;
      renderPreviewNow(request);
    });
  }, getPreviewDebounceMs(force));
  return request.id;
}

function renderSrcdocPreviewNow(rawCode, request) {
  if (!editor || !previewIframe || !request || !isCurrentPreviewRequest(request)) return;
  const isEmpty = isEmptyPreviewCode(rawCode);
  previewIframe.classList.toggle('is-empty', isEmpty);

  const focusPolicy = getPreviewFocusPolicyForRender();
  previewBlockFocusForCurrentRender = focusPolicy.blockFocus;
  const previewCode = isEmpty ? createEmptyProjectPreviewCode('') : rawCode;
  const renderSignature = `srcdoc:${previewBlockFocusForCurrentRender ? 'blocked' : 'interactive'}:${previewCode}`;
  const code = applyNonDraggableImageGuard(previewCode, {
    preventPreviewFocus: previewBlockFocusForCurrentRender,
    renderToken: request.id
  });
  updateEditorPlaceholder();

  if (!request.forceNavigation && previewLifecycle.mode === 'srcdoc' && renderSignature === lastPreviewCode) {
    clearTimeout(renderingTimeoutId);
    previewLifecycle.phase = 'idle';
    setPreviewStatus(PREVIEW_IDLE_LABEL, 'idle');
    return;
  }

  if (!isCurrentPreviewRequest(request)) return;
  lastPreviewCode = renderSignature;
  projectPreviewLastUrl = '';
  previewLifecycle.mode = 'srcdoc';
  previewLifecycle.committedGeneration = request.id;
  previewLifecycle.activeDiagnosticToken = String(request.id);
  previewLifecycle.phase = 'navigating';

  clearTimeout(renderingTimeoutId);
  renderingTimeoutId = setTimeout(() => {
    setPreviewStatus(PREVIEW_RENDERING_LABEL, 'rendering');
  }, 250);

  previewShouldRestoreEditorFocus = focusPolicy.restoreFocus;
  previewLifecycle.expectedNavigation = {
    mode: 'srcdoc',
    token: String(request.id),
    generation: request.id,
    reason: request.reason
  };
  window.clearPreviewDiagnostics?.();
  setPreviewFrameIsolation(!isEmpty && previewCodeUsesEditorBlobs);
  previewIframe.removeAttribute('src');
  previewIframe.srcdoc = code;
}

function getProjectPreviewRenderTarget(request, entryFile) {
  const entryPath = normalizeProjectPath(entryFile?.name || '');
  const desiredPath = normalizeProjectPath(
    request.targetPath ||
    request.currentPath ||
    (previewLifecycle.homeNavigationPending ? entryPath : previewLifecycle.projectPath) ||
    entryPath
  );

  if (!desiredPath || desiredPath.toLowerCase() === entryPath.toLowerCase()) {
    projectPreviewMissingPath = '';
    projectPreviewNotifiedMissingPath = '';
    return entryPath;
  }
  if (isKnownProjectPreviewPath(desiredPath)) {
    projectPreviewMissingPath = '';
    projectPreviewNotifiedMissingPath = '';
    return desiredPath;
  }

  const shouldNotify = projectPreviewNotifiedMissingPath !== desiredPath;
  projectPreviewMissingPath = desiredPath;
  projectPreviewNotifiedMissingPath = desiredPath;
  if (shouldNotify) {
    showToast(
      currentLocale === 'es'
        ? `La página ${getCompactPreviewPath(desiredPath)} ya no existe. Se volvió a la entrada.`
        : `${getCompactPreviewPath(desiredPath)} no longer exists. Returned to the entry page.`,
      'info'
    );
  }
  return entryPath;
}

function getProjectPreviewTargetUrl(request, targetPath) {
  const url = new URL(getProjectPreviewUrl(targetPath, projectPreviewVersion));
  const sourceValue = request.targetUrl || '';
  if (sourceValue) {
    try {
      const source = new URL(sourceValue, location.href);
      source.searchParams.delete(PROJECT_PREVIEW_VERSION_PARAM);
      url.search = source.search;
      url.hash = source.hash;
    } catch {}
  } else {
    const search = request.currentSearch || '';
    const hash = request.currentHash || '';
    try {
      const source = new URL(`${location.origin}/${search}${hash}`);
      source.searchParams.delete(PROJECT_PREVIEW_VERSION_PARAM);
      url.search = source.search;
      url.hash = source.hash;
    } catch {}
  }
  url.searchParams.set(PROJECT_PREVIEW_VERSION_PARAM, String(projectPreviewVersion));
  return url.href;
}

function navigatePreviewFrameToUrl(url, { push = false } = {}) {
  setPreviewFrameIsolation(true);
  previewIframe.removeAttribute('srcdoc');
  try {
    if (push) previewIframe.contentWindow.location.assign(url);
    else previewIframe.contentWindow.location.replace(url);
  } catch {
    previewIframe.src = url;
  }
}

async function renderProjectPreviewNow(request) {
  if (!editor || !previewIframe || !request || !isCurrentPreviewRequest(request)) return;
  previewLifecycle.phase = 'syncing';
  setPreviewStatus(currentLocale === 'es' ? 'Preparando' : 'Preparing', 'syncing');

  const entryFile = getEntryFile();
  if (!entryFile) {
    renderSrcdocPreviewNow(createEmptyProjectPreviewCode(), request);
    return;
  }

  if (!getFileText(entryFile).trim()) {
    renderSrcdocPreviewNow(createEmptyProjectPreviewCode(''), request);
    return;
  }

  previewIframe.classList.remove('is-empty');
  updateEditorPlaceholder();

  const focusPolicy = getPreviewFocusPolicyForRender();
  previewBlockFocusForCurrentRender = focusPolicy.blockFocus;
  if (projectPreviewLastBlockFocus !== previewBlockFocusForCurrentRender) {
    projectPreviewLastBlockFocus = previewBlockFocusForCurrentRender;
    markProjectPreviewDirty(null, { all: true });
  }
  const hasServiceWorkerPreview = await syncProjectPreviewSnapshot({
    full: request.fullSync,
    requestId: request.id
  });
  if (!isCurrentPreviewRequest(request)) return;

  if (!hasServiceWorkerPreview) {
    renderSrcdocPreviewNow(getCurrentPreviewCode(), request);
    return;
  }

  const targetPath = getProjectPreviewRenderTarget(request, entryFile);
  const targetUrl = getProjectPreviewTargetUrl(request, targetPath);
  const renderSignature = `project:${targetPath}:${projectPreviewVersion}`;
  if (
    !request.forceNavigation &&
    previewLifecycle.mode === 'project' &&
    renderSignature === lastPreviewCode &&
    targetUrl === projectPreviewLastUrl
  ) {
    clearTimeout(renderingTimeoutId);
    previewLifecycle.phase = 'idle';
    setPreviewStatus(PREVIEW_IDLE_LABEL, 'idle');
    return;
  }

  if (!isCurrentPreviewRequest(request)) return;
  lastPreviewCode = renderSignature;
  projectPreviewLastUrl = targetUrl;
  setProjectPreviewLocation(targetUrl, targetPath);
  previewLifecycle.mode = 'project';
  previewLifecycle.committedGeneration = request.id;
  previewLifecycle.activeDiagnosticToken = String(projectPreviewVersion);
  previewLifecycle.phase = 'navigating';

  clearTimeout(renderingTimeoutId);
  renderingTimeoutId = setTimeout(() => {
    setPreviewStatus(PREVIEW_RENDERING_LABEL, 'rendering');
  }, 160);

  previewShouldRestoreEditorFocus = focusPolicy.restoreFocus;
  previewLifecycle.expectedNavigation = {
    mode: 'project',
    url: targetUrl,
    path: targetPath,
    token: String(projectPreviewVersion),
    generation: request.id,
    reason: request.reason
  };
  window.clearPreviewDiagnostics?.();
  // Following a link adds a history entry, so `history.back()` in the page
  // returns to the previous page; edits and recoveries replace the document.
  navigatePreviewFrameToUrl(targetUrl, { push: request.reason === 'link' });
}

function renderPreviewNow(request = null) {
  if (!editor || !previewIframe) return;
  const activeRequest = request || createPreviewRenderRequest({ reason: 'direct' });
  if (!isCurrentPreviewRequest(activeRequest)) return;
  if (previewLifecycle.scheduledRequest?.id === activeRequest.id) {
    previewLifecycle.scheduledRequest = null;
  }

  if (editorMode === 'unified') {
    renderSrcdocPreviewNow(getCurrentPreviewCode(), activeRequest);
    return;
  }

  void renderProjectPreviewNow(activeRequest).catch(error => {
    if (!isCurrentPreviewRequest(activeRequest)) return;
    previewLifecycle.phase = 'error';
    setPreviewStatus(currentLocale === 'es' ? 'Error de vista previa' : 'Preview error', 'error');
    console.error('Error renderizando la vista previa', error);
  });
}

function getEditorLineHeight(fontSize = editorFontSize) {
  return Math.round(fontSize * 1.4);
}

function syncEditorTypographyVariables() {
  const editorContainer = document.getElementById('editor-container');
  if (!editorContainer) return;

  editorContainer.style.setProperty('--editor-font-size', `${editorFontSize}px`);
  editorContainer.style.setProperty('--editor-line-height', `${getEditorLineHeight()}px`);
}

function setEditorFontSize(fontSize) {
  const nextSize = Math.min(EDITOR_MAX_FONT_SIZE, Math.max(EDITOR_MIN_FONT_SIZE, fontSize));
  if (nextSize === editorFontSize) return;

  editorFontSize = nextSize;
  syncEditorTypographyVariables();

  if (monacoLoaded && editor && typeof editor.updateOptions === 'function') {
    editor.updateOptions({
      fontSize: editorFontSize,
      lineHeight: getEditorLineHeight()
    });
    syncEditorZoomGutter();
  } else {
    scheduleFallbackEditorChromeSync();
  }
}

function syncEditorZoomGutter() {
  if (!monacoLoaded || !editor || typeof editor.getLayoutInfo !== 'function') return;

  const isMobile = window.innerWidth <= 768;
  // Apply the gutter options first: measuring before they change (e.g. when
  // the window crosses the mobile breakpoint) leaves the code column narrower
  // than the centered line numbers, which then overlap the code.
  editor.updateOptions({
    lineNumbersMinChars: isMobile ? 2 : 3,
    folding: !isMobile
  });

  const layoutInfo = editor.getLayoutInfo();
  const options = editor.getRawOptions?.();
  const currentDecorationsWidth = Number(options?.lineDecorationsWidth) || 0;
  const fixedGutterWidth = layoutInfo.contentLeft - currentDecorationsWidth;
  const nextDecorationsWidth = Math.max(0, Math.round(EDITOR_CONTENT_LEFT - fixedGutterWidth));

  if (nextDecorationsWidth !== currentDecorationsWidth) {
    editor.updateOptions({ lineDecorationsWidth: nextDecorationsWidth });
  }
}

let showEditorZoomIndicator = () => {};

function initEditorWheelZoom() {
  const editorContainer = document.getElementById('editor-container');
  if (!editorContainer) return;

  const zoomIndicator = document.createElement('div');
  zoomIndicator.className = 'editor-zoom-indicator';
  zoomIndicator.setAttribute('role', 'status');
  zoomIndicator.setAttribute('aria-live', 'polite');
  editorContainer.appendChild(zoomIndicator);
  let hideZoomIndicatorTimeout = null;

  const showZoomIndicator = () => {
    const percentage = Math.round((editorFontSize / EDITOR_DEFAULT_FONT_SIZE) * 100);
    zoomIndicator.textContent = `${percentage}%`;
    zoomIndicator.classList.add('visible');
    clearTimeout(hideZoomIndicatorTimeout);
    hideZoomIndicatorTimeout = setTimeout(() => {
      zoomIndicator.classList.remove('visible');
    }, 900);
  };

  showEditorZoomIndicator = showZoomIndicator;
  syncEditorTypographyVariables();
  editorContainer.addEventListener('wheel', (event) => {
    if (!event.ctrlKey || event.deltaY === 0) return;

    event.preventDefault();
    event.stopPropagation();
    setEditorFontSize(editorFontSize + (event.deltaY < 0 ? 1 : -1));
    showZoomIndicator();
  }, { passive: false, capture: true });
}

initEditorWheelZoom();

let fallbackEditorChromeFrame = 0;

function syncFallbackEditorChrome() {
  fallbackEditorChromeFrame = 0;
  if (monacoLoaded || !fallbackTextarea || !fallbackLineNumbers || !fallbackCurrentLine) return;

  const value = fallbackTextarea.value || '';
  const lineCount = Math.max(1, value.split('\n').length);
  const currentLine = value.slice(0, fallbackTextarea.selectionStart || 0).split('\n').length;
  const lineHeight = getEditorLineHeight();
  const scrollTop = fallbackTextarea.scrollTop || 0;
  const firstVisibleLine = Math.max(0, Math.floor(scrollTop / lineHeight) - 1);
  const visibleLineCount = Math.ceil((fallbackTextarea.clientHeight || lineHeight) / lineHeight) + 3;
  const lastVisibleLine = Math.min(lineCount, firstVisibleLine + visibleLineCount);

  fallbackLineNumbers.textContent = Array.from(
    { length: lastVisibleLine - firstVisibleLine },
    (_, index) => firstVisibleLine + index + 1
  ).join('\n');
  fallbackLineNumbers.style.transform = `translateY(${(firstVisibleLine * lineHeight) - scrollTop}px)`;
  fallbackCurrentLine.style.transform = `translateY(${((currentLine - 1) * lineHeight) - scrollTop}px)`;
}

function scheduleFallbackEditorChromeSync() {
  if (monacoLoaded || fallbackEditorChromeFrame) return;
  fallbackEditorChromeFrame = requestAnimationFrame(syncFallbackEditorChrome);
}

let fallbackTouchScrollInitialized = false;
function isMobileKeyboardLikelyOpen() {
  const viewport = window.visualViewport;
  return Boolean(viewport && window.innerHeight - viewport.height > 140);
}

function initFallbackTouchScroll() {
  if (fallbackTouchScrollInitialized || !fallbackTextarea) return;
  fallbackTouchScrollInitialized = true;
  let gesture = null;

  fallbackTextarea.addEventListener('touchstart', (event) => {
    if (window.innerWidth > COMPACT_LAYOUT_MAX_WIDTH || event.touches.length !== 1) return;
    if (document.activeElement === fallbackTextarea && isMobileKeyboardLikelyOpen()) return;
    const touch = event.touches[0];
    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      scrollLeft: fallbackTextarea.scrollLeft,
      scrollTop: fallbackTextarea.scrollTop,
      moved: false
    };
    event.preventDefault();
  }, { passive: false, capture: true });

  fallbackTextarea.addEventListener('touchmove', (event) => {
    if (!gesture || event.touches.length !== 1) return;
    const touch = event.touches[0];
    gesture.lastX = touch.clientX;
    gesture.lastY = touch.clientY;
    if (Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY) > 7) {
      gesture.moved = true;
    }
    fallbackTextarea.scrollLeft = gesture.scrollLeft + gesture.startX - touch.clientX;
    fallbackTextarea.scrollTop = gesture.scrollTop + gesture.startY - touch.clientY;
    scheduleFallbackEditorChromeSync();
    event.preventDefault();
  }, { passive: false, capture: true });

  fallbackTextarea.addEventListener('touchend', (event) => {
    if (!gesture) return;
    const shouldFocus = !gesture.moved;
    gesture = null;
    event.preventDefault();
    if (shouldFocus) fallbackTextarea.focus({ preventScroll: true });
  }, { passive: false, capture: true });

  fallbackTextarea.addEventListener('touchcancel', () => {
    gesture = null;
  }, { passive: true, capture: true });
}

let monacoTouchScrollNode = null;
function initMonacoTouchScroll() {
  const editorNode = editor?.getDomNode?.();
  if (!editorNode || monacoTouchScrollNode === editorNode) return;
  monacoTouchScrollNode = editorNode;
  let gesture = null;

  editorNode.addEventListener('touchstart', (event) => {
    if (window.innerWidth > COMPACT_LAYOUT_MAX_WIDTH || event.touches.length !== 1) return;
    if (editor.hasTextFocus?.() && isMobileKeyboardLikelyOpen()) return;
    const touch = event.touches[0];
    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      scrollLeft: editor.getScrollLeft(),
      scrollTop: editor.getScrollTop(),
      moved: false
    };
    event.preventDefault();
  }, { passive: false, capture: true });

  editorNode.addEventListener('touchmove', (event) => {
    if (!gesture || event.touches.length !== 1) return;
    const touch = event.touches[0];
    gesture.lastX = touch.clientX;
    gesture.lastY = touch.clientY;
    if (Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY) > 7) {
      gesture.moved = true;
    }
    editor.setScrollLeft(gesture.scrollLeft + gesture.startX - touch.clientX);
    editor.setScrollTop(gesture.scrollTop + gesture.startY - touch.clientY);
    event.preventDefault();
  }, { passive: false, capture: true });

  editorNode.addEventListener('touchend', (event) => {
    if (!gesture) return;
    const completedGesture = gesture;
    gesture = null;
    event.preventDefault();
    if (completedGesture.moved) return;

    const target = editor.getTargetAtClientPoint?.(completedGesture.lastX, completedGesture.lastY);
    if (target?.position) editor.setPosition(target.position);
    editor.focus();
  }, { passive: false, capture: true });

  editorNode.addEventListener('touchcancel', () => {
    gesture = null;
  }, { passive: true, capture: true });
}

// Fallback editor implementation if CDN fails or runs offline
function initFallbackEditor(showToastFlag = false) {
  if (monacoLoaded) return;
  fallbackTextarea.style.display = 'block';
  fallbackTextarea.value = INITIAL_EDITOR_CODE;
  fallbackLastKnownValue = fallbackTextarea.value;
  fallbackTextarea.placeholder = EDITOR_PLACEHOLDER_TEXT;
  initFallbackTouchScroll();
  scheduleFallbackEditorChromeSync();

  fallbackTextarea.addEventListener('input', () => {
    const previousValue = fallbackLastKnownValue;
    const activeFile = editorMode === 'split' ? files.find(file => file.id === activeFileId) : getEntryFile();
    if (!isRestoringHistory) {
      // The DOM input event exposes the new value only.  Use the last value
      // observed by the fallback to capture the actual pre-edit snapshot.
      handleTextChange({
        unifiedContent: editorMode === 'unified' ? previousValue : undefined,
        contentOverrides: activeFile ? { [activeFile.id]: previousValue } : null
      });
      window.cancelPendingImportOperations?.();
    }
    saveFallbackTabContent();
    fallbackLastKnownValue = fallbackTextarea.value;
    window.scheduleRecoverySave?.();
    schedulePreviewUpdate({ force: false });
    scheduleFallbackEditorChromeSync();
  });

  ['click', 'keyup', 'select', 'scroll'].forEach(eventName => {
    fallbackTextarea.addEventListener(eventName, scheduleFallbackEditorChromeSync, { passive: true });
  });

  fallbackTextarea.addEventListener('paste', () => {
    setTimeout(() => {
      saveFallbackTabContent();
      schedulePreviewUpdate({ force: true });
    }, 0);
  });

  editor = {
    getValue: () => {
      saveFallbackTabContent();
      return getCurrentEditorDocumentText();
    },
    setValue: (val) => {
      if (editorMode === 'unified') {
        cameFromSplitMode = false;
        const rootFolder = getProjectRootFolder();
        disposeAllFileModels();
        files = [
          createTextFileRecord(rootFolder + 'index.html', val, { id: '1' })
        ];
        openFileIds = ['1'];
        selectedEntryFileId = '1';
        fallbackTextarea.value = val;
        fallbackLastKnownValue = val;
      } else {
        replaceProjectWithSplitSource(val, { emptyAsSingleFile: true });
        fallbackTextarea.value = getFileText(files.find(file => file.id === '1'));
        fallbackLastKnownValue = fallbackTextarea.value;
        renderActiveFileSummary();
        renderFileExplorer();
      }
      updateEditorPlaceholder();
      updatePreview();
    },
    layout: () => {},
    onDidChangeModelContent: () => {} // dummy
  };

  updateEditorPlaceholder();
  updatePreview();
  if (window.innerWidth > COMPACT_LAYOUT_MAX_WIDTH) {
    fallbackTextarea.focus();
  }
  if (showToastFlag) {
    showToast(t('toast_offline_mode'), 'info');
  }
}

// Initialize the fallback editor immediately to show content and allow editing without blocking
initFallbackEditor(false);

let monacoLoadPromise = null;
let monacoLoadFailureToastShown = false;

// Upgrade the instant fallback editor to the locally hosted Monaco build.
// The promise is shared so interaction, first-paint warmup and retries cannot
// start competing AMD loads.
function upgradeToMonaco() {
  if (monacoLoaded) return Promise.resolve(true);
  if (monacoLoadPromise) return monacoLoadPromise;

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.monacoLoader = 'true';

    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      s.onload = null;
      s.onerror = null;
      if (error) {
        s.remove();
        reject(error);
      } else {
        resolve();
      }
    };
    const timeoutId = setTimeout(() => {
      finish(new Error(`Monaco loader timed out after ${MONACO_LOAD_TIMEOUT_MS} ms`));
    }, MONACO_LOAD_TIMEOUT_MS);

    s.onload = () => finish();
    s.onerror = () => finish(new Error(`Failed to load Monaco loader: ${src}`));
    document.head.appendChild(s);
  });

  const startMonacoLoad = () => new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Monaco modules timed out after ${MONACO_LOAD_TIMEOUT_MS} ms`));
    }, MONACO_LOAD_TIMEOUT_MS);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error instanceof Error ? error : new Error(String(error || 'Monaco initialization failed')));
    };

    try {
      require.config({
        paths: { vs: MONACO_BASE_PATH },
        waitSeconds: Math.ceil(MONACO_LOAD_TIMEOUT_MS / 1000)
      });
      require(['vs/editor/editor.main'], function () {
        if (settled) return;
        try {
           // The mode and active file may have changed while the loader was
           // in flight. Capture the fallback's raw document at completion,
           // then connect the model for the mode that is current now.
           saveFallbackTabContent();
           const initialEditorValue = getCurrentEditorDocumentText() || INITIAL_EDITOR_CODE;
           const fallbackSelection = {
             start: fallbackTextarea.selectionStart,
             end: fallbackTextarea.selectionEnd,
             scrollTop: fallbackTextarea.scrollTop,
             scrollLeft: fallbackTextarea.scrollLeft,
             hadFocus: document.activeElement === fallbackTextarea
           };
           const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        // Define custom themes matching our Artificial Analysis variables with improved contrast
        monaco.editor.defineTheme('app-dark-theme', {
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': '#0b0d13',
            'editor.foreground': '#ffffff',
            'editorLineNumber.foreground': '#94a3b8',
            'editorLineNumber.activeForeground': '#8842FD',
            'editor.lineHighlightBackground': '#151821',
            'editor.selectionBackground': '#2d2542',
            'scrollbarSlider.background': '#151821',
            'scrollbarSlider.hoverBackground': '#1f2433',
            'scrollbarSlider.activeBackground': '#2d344a',
          }
        });

        monaco.editor.defineTheme('app-light-theme', {
          base: 'vs',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': '#ffffff',
            'editor.foreground': '#020617',
            'editorLineNumber.foreground': '#94a3b8',
            'editorLineNumber.activeForeground': '#8842FD',
            'editor.lineHighlightBackground': '#e2e8f0',
            'editor.selectionBackground': '#f1e9ff',
            'scrollbarSlider.background': '#cbd5e1',
            'scrollbarSlider.hoverBackground': '#94a3b8',
            'scrollbarSlider.activeBackground': '#64748b',
          }
        });

        // Create the models for Monaco Editor
         unifiedModel = monaco.editor.createModel(initialEditorValue, 'html');
         unifiedLastKnownContent = initialEditorValue;
         unifiedModel.onDidChangeContent(() => {
           const previousContent = unifiedLastKnownContent;
           const nextContent = unifiedModel.getValue();
           const entryFile = getEntryFile();
           if (!isRestoringHistory) {
             window.cancelPendingImportOperations?.();
             handleTextChange({
               unifiedContent: previousContent,
               contentOverrides: entryFile ? { [entryFile.id]: previousContent } : null
             });
           }
           unifiedLastKnownContent = nextContent;
           if (editorMode === 'unified' && entryFile) {
             entryFile.content = nextContent;
             entryFile.size = new Blob([nextContent]).size;
             markProjectPreviewDirty(entryFile.name);
           }
           window.scheduleRecoverySave?.();
           updateEditorPlaceholder();
           schedulePreviewUpdate({ force: false });
         });

        const isMobile = window.innerWidth <= 768;
        // Create the editor instance using unifiedModel initially
        editor = monaco.editor.create(document.getElementById('editor-container'), {
          model: unifiedModel,
          theme: isDark ? 'app-dark-theme' : 'app-light-theme',
          automaticLayout: true,
          fontSize: editorFontSize,
          lineHeight: getEditorLineHeight(),
          fontFamily: "'JetBrains Mono', Consolas, monospace",
          minimap: { enabled: false },
          lineNumbers: 'on',
          lineNumbersMinChars: isMobile ? 2 : 3,
          lineDecorationsWidth: isMobile ? 8 : 24,
          glyphMargin: false,
          folding: !isMobile,
          roundedSelection: true,
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: 'on',
          largeFileOptimizations: true,
          fixedOverflowWidgets: true,
          bracketPairColorization: { enabled: false },
          guides: { bracketPairs: false, indentation: false },
          occurrencesHighlight: false,
          selectionHighlight: false,
          colorDecorators: false,
           padding: { top: 16 }
         });
         // Only now is the fallback-to-Monaco transition valid.  In split
         // mode the active file model wins; the unified model is never forced
         // into the editor merely because it was created first.
         monacoLoaded = true;
         syncModelsForFiles();
         if (editorMode === 'split') {
           const activeFile = files.find(file => file.id === activeFileId);
           editor.setModel(activeFile && isEditableFile(activeFile) ? (fileModels[activeFile.id] || null) : null);
         } else {
           editor.setModel(unifiedModel);
         }
         fallbackTextarea.style.display = 'none';
         document.getElementById('editor-container')?.classList.add('monaco-ready');
         if (fallbackSelection.hadFocus && editor.getModel()) {
           const model = editor.getModel();
           const start = model.getPositionAt(Math.min(fallbackSelection.start, model.getValueLength()));
           const end = model.getPositionAt(Math.min(fallbackSelection.end, model.getValueLength()));
           editor.setSelection(new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column));
           editor.setScrollTop(fallbackSelection.scrollTop || 0);
           editor.setScrollLeft(fallbackSelection.scrollLeft || 0);
         }
         initMonacoTouchScroll();

        let activeLineNumberDecorations = [];
        const syncActiveLineNumber = () => {
          const lineNumber = editor.getPosition()?.lineNumber;
          activeLineNumberDecorations = editor.deltaDecorations(
            activeLineNumberDecorations,
            lineNumber ? [{
              range: new monaco.Range(lineNumber, 1, lineNumber, 1),
              options: { lineNumberClassName: 'viewer-active-line-number' }
            }] : []
          );
        };
        editor.onDidChangeCursorPosition(syncActiveLineNumber);
        editor.onDidChangeModel(syncActiveLineNumber);
        syncActiveLineNumber();

        syncEditorZoomGutter();

        // Initial render
        updateEditorPlaceholder();
        updatePreview();
        queueEditorLayout();
        if (document.activeElement === fallbackTextarea) {
          editor.focus();
        }

        // Evento de pegado para actualizar al instante
        editor.onDidPaste(() => {
          schedulePreviewUpdate({ force: true });
        });

        // Monaco-specific keybindings
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, triggerExport);
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, triggerImport);
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, triggerPreviewFull);
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, triggerPreviewFull);

          settled = true;
          clearTimeout(timeoutId);
          resolve(true);
         } catch (error) {
           monacoLoaded = false;
           try { unifiedModel?.dispose?.(); } catch {}
           unifiedModel = undefined;
           editor = null;
           fallbackTextarea.style.display = 'block';
           document.getElementById('editor-container')?.classList.remove('monaco-ready');
           fail(error);
        }
      }, function (err) {
        fail(err);
      });
    } catch (e) {
      fail(e);
    }
  });

  const ensureLoader = typeof window.require === 'undefined'
    ? loadScript(MONACO_LOADER_PATH)
    : Promise.resolve();

  monacoLoadPromise = ensureLoader
    .then(startMonacoLoad)
    .catch((err) => {
      console.warn('Monaco failed to load; keeping the fallback editor available.', err);
      if (!monacoLoadFailureToastShown) {
        monacoLoadFailureToastShown = true;
        showToast(t('toast_offline_mode'), 'info');
      }
      monacoLoadPromise = null;
      return false;
    });

  return monacoLoadPromise;
}

// Start Monaco immediately after the first paint. Interaction remains a retry
// path if a deployment is incomplete or the request times out.
let monacoLoadTriggered = false;
let monacoAutomaticRetryCount = 0;
function triggerMonacoLazyLoad() {
  if (monacoLoaded || monacoLoadTriggered) return;
  monacoLoadTriggered = true;
  upgradeToMonaco().then((loaded) => {
    monacoLoadTriggered = false;
    if (loaded && editorBodyArea) {
      ['mouseenter', 'pointerdown', 'focusin'].forEach((eventName) => {
        editorBodyArea.removeEventListener(eventName, triggerMonacoLazyLoad);
      });
    } else if (!loaded && monacoAutomaticRetryCount < MONACO_MAX_AUTOMATIC_RETRIES) {
      monacoAutomaticRetryCount += 1;
      setTimeout(triggerMonacoLazyLoad, MONACO_RETRY_DELAY_MS);
    }
  });
}

const editorBodyArea = document.querySelector('.editor-body-area');
if (editorBodyArea) {
  ['mouseenter', 'pointerdown', 'focusin'].forEach((eventName) => {
    editorBodyArea.addEventListener(eventName, triggerMonacoLazyLoad);
  });
}

// Dynamic scripts do not block the current bundle or the fallback editor. Now
// that Monaco is same-origin, starting the request immediately is both the
// fastest and the most deterministic path, including in background tabs.
triggerMonacoLazyLoad();

// Update the iframe live preview content
function updatePreview({
  force = true,
  full = true,
  forceNavigation = false,
  reason = 'update',
  targetPath = '',
  targetUrl = ''
} = {}) {
  if (editorMode === 'split' && full) {
    markProjectPreviewDirty(null, { all: true });
  }
  schedulePreviewUpdate({
    force,
    forceNavigation,
    fullSync: editorMode === 'split' && full,
    reason,
    targetPath,
    targetUrl
  });
}

// Keyboard Action Helpers
function triggerExport() {
  const btn = document.getElementById('btn-export');
  if (btn) btn.click();
}

function triggerImport() {
  const btn = document.getElementById('btn-import');
  if (btn) btn.click();
}

function triggerPreviewFull() {
  const btn = document.getElementById('btn-preview-full');
  if (btn) btn.click();
}

function triggerPreviewReload() {
  projectPreviewMissingPath = '';
  projectPreviewNotifiedMissingPath = '';

  if (editorMode === 'split') {
    markProjectPreviewDirty(null, { all: true });
  }

  schedulePreviewUpdate({
    force: true,
    forceNavigation: true,
    fullSync: editorMode === 'split',
    reason: 'reload'
  });
}

function triggerFocusMode() {
  const btn = document.getElementById('btn-highlight-full');
  if (btn) btn.click();
}

// Ctrl/Cmd with +, - or 0 zooms the code editor while it has focus, matching
// the shortcuts listed in Help. Elsewhere the browser keeps its page zoom.
function handleEditorZoomShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || !editorHasKeyboardFocus()) return false;
  let nextSize = null;
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') nextSize = editorFontSize + 1;
  else if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') nextSize = editorFontSize - 1;
  else if (event.key === '0' || event.code === 'Numpad0') nextSize = EDITOR_DEFAULT_FONT_SIZE;
  if (nextSize === null) return false;
  event.preventDefault();
  event.stopPropagation();
  setEditorFontSize(nextSize);
  showEditorZoomIndicator();
  return true;
}

// Inputs such as file names keep their native undo; the app history only
// owns the code editor and the rest of the interface.
function isNativeTextEditingTarget(target) {
  if (!(target instanceof Element) || target === fallbackTextarea) return false;
  // Monaco's own text surface is the "inputarea"; its find/rename widgets
  // are ordinary inputs with their own undo.
  if (target.closest('.monaco-editor') && target.classList.contains('inputarea')) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

window.addEventListener('keydown', handleEditorZoomShortcut, true);

// Global keyboard shortcuts
window.addEventListener('keydown', (e) => {
  const isCtrlOrCmd = e.ctrlKey || e.metaKey;
  if (isCtrlOrCmd) {
    let handled = true;
    switch (e.key.toLowerCase()) {
      case 's':
        triggerExport();
        break;
      case 'o':
        triggerImport();
        break;
      case 'p':
        triggerPreviewFull();
        break;
      default:
        handled = false;
    }

    if (e.key === 'Enter') {
      triggerPreviewFull();
      handled = true;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
});

// Interceptar Deshacer (Ctrl+Z) y Rehacer (Ctrl+Y / Ctrl+Shift+Z) en fase de captura para anular Monaco
window.addEventListener('keydown', (e) => {
  const isCtrlOrCmd = e.ctrlKey || e.metaKey;
  if (isCtrlOrCmd && !e.altKey && !isNativeTextEditingTarget(e.target)) {
    const key = e.key.toLowerCase();
    if (key === 'z') {
      if (e.shiftKey) {
        triggerRedo();
      } else {
        triggerUndo();
      }
      e.preventDefault();
      e.stopPropagation();
    } else if (key === 'y') {
      triggerRedo();
      e.preventDefault();
      e.stopPropagation();
    }
  }
}, true);

function setEditorValue(value) {
  if (!editor) return;
  if (!importCommitInProgress) window.cancelPendingImportOperations?.();
  if (!isRestoringHistory) window.cancelPendingRecovery?.();
  saveHistoryState();
  const wasRestoring = isRestoringHistory;
  isRestoringHistory = true;
  try {
    if (monacoLoaded) {
      if (editorMode === 'unified') {
        cameFromSplitMode = false;
        const rootFolder = getProjectRootFolder();
        files = [
          createTextFileRecord(rootFolder + 'index.html', value, { id: '1' })
        ];
        openFileIds = ['1'];
        selectedEntryFileId = '1';

        const model = unifiedModel;
        if (model) {
          editor.setModel(model);
          model.setValue(value);
          unifiedLastKnownContent = value;
          const entryFile = files.find(file => file.id === '1');
          if (entryFile) {
            entryFile.content = value;
            entryFile.size = new Blob([value]).size;
          }
        }
      } else {
        // A mode change/import must preserve the complete HTML document.  Do
        // not silently extract inline JSON, modules, media styles or scripts
        // into synthetic files.
        disposeAllFileModels();
        replaceProjectWithSplitSource(value, { emptyAsSingleFile: true });
        normalizeProjectFiles();
        syncModelsForFiles();
        openFile('1');
      }
      if (window.innerWidth > COMPACT_LAYOUT_MAX_WIDTH) {
        editor.focus();
      }
      updateEditorPlaceholder();
      updatePreview();
    } else {
      editor.setValue(value);
      fallbackLastKnownValue = value;
    }
    window.scheduleRecoverySave?.();
  } finally {
    isRestoringHistory = wasRestoring;
  }
}
