const PROJECT_MARKER = '/__html_viewer_project__/';
const sessions = new Map();
const projectClientSessions = new Map();
const persistentSessionLoads = new Map();
const sessionUpdateQueues = new Map();
const sessionPersistenceStates = new Map();
const PROJECT_SESSION_DB = 'html-viewer-preview-sessions';
const PROJECT_SESSION_STORE = 'sessions';
const PROJECT_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Which session each preview page belongs to. Pages show their published URL
// after loading, so this mapping must survive the worker being restarted.
const PROJECT_CLIENT_DB = 'html-viewer-preview-clients';
const PROJECT_CLIENT_STORE = 'clients';
let lastPersistentSessionPrune = 0;

function openProjectClientDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_CLIENT_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROJECT_CLIENT_STORE)) {
        request.result.createObjectStore(PROJECT_CLIENT_STORE, { keyPath: 'clientId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Preview client database unavailable'));
  });
}

async function withProjectClientStore(mode, operation) {
  const database = await openProjectClientDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(PROJECT_CLIENT_STORE, mode);
      let result;
      Promise.resolve(operation(transaction.objectStore(PROJECT_CLIENT_STORE))).then(value => { result = value; }, reject);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function persistProjectClient(clientId, sessionId) {
  return withProjectClientStore('readwrite', store => {
    store.put({ clientId, sessionId, updatedAt: Date.now() });
  }).catch(() => {});
}

function readPersistedProjectClient(clientId) {
  return withProjectClientStore('readonly', store => new Promise(resolve => {
    const request = store.get(clientId);
    request.onsuccess = () => resolve(request.result?.sessionId || null);
    request.onerror = () => resolve(null);
  })).catch(() => null);
}

function pruneProjectClients(now = Date.now()) {
  return withProjectClientStore('readwrite', store => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (now - (Number(cursor.value?.updatedAt) || 0) > PROJECT_SESSION_MAX_AGE_MS) cursor.delete();
      cursor.continue();
    };
  }).catch(() => {});
}

function openProjectSessionDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_SESSION_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROJECT_SESSION_STORE)) {
        request.result.createObjectStore(PROJECT_SESSION_STORE, { keyPath: 'sessionId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir la base de datos de la previsualización'));
  });
}

async function readPersistentSession(sessionId) {
  const database = await openProjectSessionDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(PROJECT_SESSION_STORE, 'readonly');
      const request = transaction.objectStore(PROJECT_SESSION_STORE).get(sessionId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('No se pudo restaurar la previsualización'));
    });
  } finally {
    database.close();
  }
}

async function writePersistentSession(sessionId, session) {
  const database = await openProjectSessionDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(PROJECT_SESSION_STORE, 'readwrite');
      transaction.objectStore(PROJECT_SESSION_STORE).put({
        sessionId,
        siteRoot: session.siteRoot,
        version: session.version,
        updatedAt: session.updatedAt,
        files: Array.from(session.files.values())
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la previsualización'));
      transaction.onabort = () => reject(transaction.error || new Error('Se canceló el guardado de la previsualización'));
    });
  } finally {
    database.close();
  }
}

function schedulePersistentSessionWrite(sessionId) {
  const existing = sessionPersistenceStates.get(sessionId);
  if (existing) {
    existing.dirty = true;
    return existing.promise;
  }

  const state = { dirty: true, promise: null };
  state.promise = (async () => {
    // Let updates that were queued in the same editing burst converge before
    // cloning binary payloads into IndexedDB.
    await new Promise(resolve => setTimeout(resolve, 40));
    while (state.dirty) {
      state.dirty = false;
      const session = sessions.get(sessionId);
      if (session) await writePersistentSession(sessionId, session).catch(() => {});
      if (state.dirty) await new Promise(resolve => setTimeout(resolve, 40));
    }
  })().finally(() => {
    if (sessionPersistenceStates.get(sessionId) === state) {
      sessionPersistenceStates.delete(sessionId);
    }
  });
  sessionPersistenceStates.set(sessionId, state);
  return state.promise;
}

async function prunePersistentSessions(now = Date.now()) {
  if (now - lastPersistentSessionPrune < 5 * 60 * 1000) return;
  lastPersistentSessionPrune = now;
  const database = await openProjectSessionDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(PROJECT_SESSION_STORE, 'readwrite');
      const request = transaction.objectStore(PROJECT_SESSION_STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const updatedAt = Number(cursor.value?.updatedAt) || 0;
        if (now - updatedAt > PROJECT_SESSION_MAX_AGE_MS) {
          cursor.delete();
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('No se pudieron limpiar las sesiones antiguas'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('No se pudieron limpiar las sesiones antiguas'));
      transaction.onabort = () => reject(transaction.error || new Error('Se canceló la limpieza de sesiones'));
    });
  } finally {
    database.close();
  }
}

function hydrateSession(record) {
  if (!record) return null;
  if (Date.now() - (Number(record.updatedAt) || 0) > PROJECT_SESSION_MAX_AGE_MS) return null;
  const session = {
    files: new Map(),
    pathIndex: new Map(),
    siteRoot: normalizePath(record.siteRoot || ''),
    version: Number(record.version) || 0,
    updatedAt: Number(record.updatedAt) || Date.now()
  };
  for (const file of record.files || []) {
    const path = normalizePath(file?.path);
    if (!path) continue;
    const storedFile = { ...file, path };
    session.files.set(path, storedFile);
    session.pathIndex.set(path.toLowerCase(), path);
  }
  return session;
}

async function restoreSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  if (persistentSessionLoads.has(sessionId)) return persistentSessionLoads.get(sessionId);

  const pending = readPersistentSession(sessionId)
    .then(hydrateSession)
    .catch(() => null)
    .then(session => {
      if (session) sessions.set(sessionId, session);
      return session;
    })
    .finally(() => persistentSessionLoads.delete(sessionId));
  persistentSessionLoads.set(sessionId, pending);
  return pending;
}

async function getOrRestoreSession(sessionId) {
  return sessions.get(sessionId) || await restoreSession(sessionId);
}

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    prunePersistentSessions().catch(() => {}),
    pruneProjectClients()
  ]));
});

function normalizePath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

function decodePath(path) {
  try {
    return decodeURIComponent(String(path || ''));
  } catch {
    return String(path || '');
  }
}

function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join('/'));
}

function getProjectUrl(sessionId, path, baseUrl) {
  const encodedPath = normalizePath(path)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const base = new URL(baseUrl);
  const scope = new URL(self.registration.scope);
  const markerIndex = base.pathname.indexOf(PROJECT_MARKER);
  const scopeMarkerIndex = scope.pathname.indexOf(PROJECT_MARKER);
  const rawAppBasePath = markerIndex >= 0
    ? base.pathname.slice(0, markerIndex)
    : (scopeMarkerIndex >= 0 ? scope.pathname.slice(0, scopeMarkerIndex) : '/');
  const appBasePath = (rawAppBasePath || '/').endsWith('/') ? (rawAppBasePath || '/') : `${rawAppBasePath}/`;
  const trailingSlash = String(path).endsWith('/') && encodedPath ? '/' : '';
  const projectPath = `${appBasePath}${PROJECT_MARKER.slice(1)}${encodeURIComponent(sessionId)}/${encodedPath}${trailingSlash}`;
  const target = new URL(projectPath, base.origin);
  target.search = base.search;
  return target.href;
}

function parseProjectUrl(url) {
  const markerIndex = url.pathname.indexOf(PROJECT_MARKER);
  if (markerIndex === -1) return null;

  const rest = url.pathname.slice(markerIndex + PROJECT_MARKER.length);
  const slashIndex = rest.indexOf('/');
  if (slashIndex === -1) return null;

  return {
    sessionId: decodePath(rest.slice(0, slashIndex)),
    path: normalizePath(decodePath(rest.slice(slashIndex + 1)))
  };
}

function getSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      files: new Map(),
      pathIndex: new Map(),
      siteRoot: '',
      version: 0,
      updatedAt: Date.now()
    };
    sessions.set(sessionId, session);
  }
  return session;
}

function pruneSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.updatedAt > PROJECT_SESSION_MAX_AGE_MS) {
      sessions.delete(sessionId);
    }
  }
  for (const [clientId, sessionId] of projectClientSessions) {
    if (!sessions.has(sessionId)) {
      projectClientSessions.delete(clientId);
    }
  }
}

function enqueueSessionUpdate(sessionId, update) {
  const previous = sessionUpdateQueues.get(sessionId) || Promise.resolve();
  const pending = previous.catch(() => {}).then(update);
  let tracked;
  tracked = pending.finally(() => {
    if (sessionUpdateQueues.get(sessionId) === tracked) {
      sessionUpdateQueues.delete(sessionId);
    }
  });
  sessionUpdateQueues.set(sessionId, tracked);
  return tracked;
}

function createResponseHeaders(file, size) {
  let contentType = file.mimeType || 'application/octet-stream';
  if (!file.isBinary && !/;\s*charset=/i.test(contentType) && /^(?:text\/|application\/(?:javascript|json|manifest\+json|xml))/i.test(contentType)) {
    contentType += ';charset=utf-8';
  }
  return new Headers({
    'Content-Type': contentType,
    'Content-Length': String(size),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'X-HTML-Viewer-Project': '1'
  });
}

function parseByteRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || '').trim());
  if (!match) return undefined;
  if (size <= 0) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

// Shown when a full-page window outlives the editor session it belonged to.
function responseForMissingSession(request) {
  const body = '<!doctype html><meta charset="utf-8"><meta name="html-viewer-missing-session" content="1"><title>HTML Viewer</title><p>Preview not available.</p>';
  return new Response(request?.method === 'HEAD' ? null : body, {
    status: 404,
    headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function responseForFile(file, request = null, status = 200) {
  if (!file) {
    const body = request?.method === 'HEAD' ? null : 'Not found';
    return new Response(body, {
      status: 404,
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        'Content-Length': '9',
        'Cache-Control': 'no-store'
      }
    });
  }

  const bodyBlob = file.isBinary
    ? (file.blob || new Blob([]))
    : new Blob([file.content || ''], { type: file.mimeType || 'text/plain;charset=utf-8' });
  const headers = createResponseHeaders(file, bodyBlob.size);
  const isHead = request?.method === 'HEAD';
  const rangeHeader = status === 200 ? request?.headers?.get('Range') : null;

  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, bodyBlob.size);
    if (range === null) {
      headers.set('Content-Range', `bytes */${bodyBlob.size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      const partialBody = bodyBlob.slice(range.start, range.end + 1, file.mimeType || undefined);
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${bodyBlob.size}`);
      headers.set('Content-Length', String(partialBody.size));
      return new Response(isHead ? null : partialBody, { status: 206, headers });
    }
  }

  return new Response(isHead ? null : bodyBlob, { status, headers });
}

function getStoredPath(session, path) {
  const cleanPath = normalizePath(path);
  if (!cleanPath) return null;
  if (session.files.has(cleanPath)) return cleanPath;
  return session.pathIndex.get(cleanPath.toLowerCase()) || null;
}

function getFileByPath(session, path) {
  const storedPath = getStoredPath(session, path);
  return storedPath ? session.files.get(storedPath) : null;
}

function getRouteCandidates(path) {
  const cleanPath = normalizePath(path);
  const candidates = [];
  const add = candidate => {
    const normalized = normalizePath(candidate);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  if (!cleanPath) {
    add('index.html');
    add('index.htm');
    return candidates;
  }

  add(cleanPath);

  if (cleanPath.endsWith('/')) {
    add(`${cleanPath}index.html`);
    add(`${cleanPath}index.htm`);
    return candidates;
  }

  const lastSegment = cleanPath.split('/').pop() || '';
  const hasExtension = /\.[^/.]+$/.test(lastSegment);
  if (!hasExtension) {
    add(`${cleanPath}.html`);
    add(`${cleanPath}.htm`);
    add(`${cleanPath}/index.html`);
    add(`${cleanPath}/index.htm`);
  }

  return candidates;
}

function candidateScopes(session, path, preferSiteRoot = false) {
  const cleanPath = normalizePath(path);
  const siteRoot = normalizePath(session.siteRoot || '');
  const scopedPath = siteRoot && cleanPath && !cleanPath.toLowerCase().startsWith(`${siteRoot.toLowerCase()}/`)
    ? joinPath(siteRoot, cleanPath)
    : cleanPath;
  const rootIndexPath = siteRoot || cleanPath ? joinPath(siteRoot, cleanPath) : siteRoot;

  const scopes = preferSiteRoot
    ? [scopedPath, cleanPath]
    : [cleanPath, scopedPath];

  if (!cleanPath && siteRoot) scopes.unshift(rootIndexPath);
  return scopes.filter((scope, index, arr) => arr.indexOf(scope) === index);
}

function resolveStaticPath(session, path, { preferSiteRoot = false } = {}) {
  for (const scope of candidateScopes(session, path, preferSiteRoot)) {
    for (const candidate of getRouteCandidates(scope)) {
      const storedPath = getStoredPath(session, candidate);
      if (storedPath) return storedPath;
    }
  }
  return null;
}

function parseRedirectRules(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [from, to, status] = line.split(/\s+/);
      return { from, to, status: Number.parseInt(status || '200', 10) || 200 };
    })
    .filter(rule => rule.from && rule.to && !/^[a-z][a-z0-9+.-]*:/i.test(rule.to));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchRedirectRule(ruleFrom, path) {
  const routePath = `/${normalizePath(path)}`;
  const from = ruleFrom.startsWith('/') ? ruleFrom : `/${ruleFrom}`;
  const parameterNames = [];
  let pattern = '';
  from.split('/').forEach((segment, index) => {
    if (index > 0) pattern += '/';
    if (segment === '*') {
      parameterNames.push('splat');
      pattern += '(.*)';
    } else if (segment.startsWith(':') && segment.length > 1) {
      parameterNames.push(segment.slice(1));
      pattern += '([^/]+)';
    } else {
      pattern += escapeRegex(segment);
    }
  });
  const match = new RegExp(`^${pattern}$`).exec(routePath);
  if (!match) return null;
  return Object.fromEntries(parameterNames.map((name, index) => [name, decodePath(match[index + 1] || '')]));
}

function applyRedirectParams(target, params) {
  let result = String(target || '');
  Object.entries(params || {}).forEach(([name, value]) => {
    result = result.split(`:${name}`).join(value);
  });
  if (params?.splat !== undefined) result = result.split('*').join(params.splat);
  return result;
}

function resolveRedirectTarget(session, path, preferSiteRoot) {
  const redirectFilePath = resolveStaticPath(session, '_redirects', { preferSiteRoot: true });
  const redirectFile = redirectFilePath ? session.files.get(redirectFilePath) : null;
  if (!redirectFile || redirectFile.isBinary) return null;

  const cleanPath = normalizePath(path);
  const siteRoot = normalizePath(session.siteRoot || '');
  const routePaths = [cleanPath];
  if (siteRoot && cleanPath.toLowerCase().startsWith(`${siteRoot.toLowerCase()}/`)) {
    routePaths.unshift(cleanPath.slice(siteRoot.length + 1));
  }

  for (const rule of parseRedirectRules(redirectFile.content)) {
    let params = null;
    for (const routePath of routePaths) {
      params = matchRedirectRule(rule.from, routePath);
      if (params) break;
    }
    if (!params) continue;
    const targetPath = normalizePath(applyRedirectParams(rule.to, params));
    const resolvedPath = resolveStaticPath(session, targetPath, { preferSiteRoot });
    if (resolvedPath) return { path: resolvedPath, status: rule.status };
  }
  return null;
}

function resolveProjectRequest(session, path, { preferSiteRoot = false } = {}) {
  const resolvedPath = resolveStaticPath(session, path, { preferSiteRoot });
  if (resolvedPath) {
    return { path: resolvedPath, file: session.files.get(resolvedPath), status: 200 };
  }

  const redirect = resolveRedirectTarget(session, path, preferSiteRoot);
  if (redirect) {
    return { path: redirect.path, file: session.files.get(redirect.path), status: redirect.status };
  }

  const notFoundPath = resolveStaticPath(session, '404.html', { preferSiteRoot: true });
  if (notFoundPath) {
    return { path: notFoundPath, file: session.files.get(notFoundPath), status: 404 };
  }

  return { path: '', file: null, status: 404 };
}

function resolveProjectRequestWithSpaFallback(session, path, request, options = {}) {
  const route = resolveProjectRequest(session, path, options);
  if (route.file || (request.mode !== 'navigate' && request.destination !== 'document')) return route;

  const cleanPath = normalizePath(path);
  const lastSegment = cleanPath.split('/').pop() || '';
  if (!cleanPath || /\.[^/.]+$/.test(lastSegment)) return route;

  const entryPath = resolveStaticPath(session, '', { preferSiteRoot: true });
  if (!entryPath) return route;
  return { path: entryPath, file: session.files.get(entryPath), status: 200, spaFallback: true };
}

function responseForResolvedRoute(route, request, sessionId, baseUrl) {
  if (!route.file) return responseForFile(null, request);
  if ([301, 302, 303, 307, 308].includes(route.status)) {
    return Response.redirect(getProjectUrl(sessionId, route.path, baseUrl), route.status);
  }
  // Directory indexes need a trailing slash so native relative fetches,
  // links and module imports resolve against the directory after reload.
  const requestUrl = new URL(request.url);
  if (route.status === 200 && !route.spaFallback && /\/index\.html?$/i.test(route.path) &&
      (request.mode === 'navigate' || ['document', 'iframe', 'frame'].includes(request.destination)) &&
      !requestUrl.pathname.endsWith('/') && !/\/index\.html?$/i.test(requestUrl.pathname)) {
    return Response.redirect(getProjectUrl(sessionId, route.path.replace(/index\.html?$/i, ''), baseUrl), 302);
  }
  return responseForFile(route.file, request, route.status);
}

async function getSessionFromClient(event) {
  const clientId = event.clientId;
  if (!clientId) return null;

  const knownSessionId = projectClientSessions.get(clientId);
  if (knownSessionId) return knownSessionId;

  const client = await self.clients.get(clientId);
  const parsed = client?.url ? parseProjectUrl(new URL(client.url)) : null;
  const sessionId = parsed?.sessionId || (client ? await readPersistedProjectClient(clientId) : null);
  if (sessionId) projectClientSessions.set(clientId, sessionId);
  return sessionId;
}

function rememberProjectClient(event, sessionId) {
  const clientId = event.resultingClientId || event.clientId;
  if (clientId && sessionId && projectClientSessions.get(clientId) !== sessionId) {
    projectClientSessions.set(clientId, sessionId);
    if (event.resultingClientId) event.waitUntil(persistProjectClient(clientId, sessionId));
  }
}

// Only the editor may change preview sessions; previewed pages are clients of
// this worker too and must not rewrite another session's files.
function isProjectClient(source) {
  if (!source?.id) return false;
  if (projectClientSessions.has(source.id)) return true;
  try { return Boolean(parseProjectUrl(new URL(source.url))); } catch { return false; }
}

self.addEventListener('message', event => {
  const data = event.data || {};
  const replyPort = event.ports && event.ports[0];
  const reply = payload => {
    if (replyPort) replyPort.postMessage(payload);
  };
  if (isProjectClient(event.source)) {
    reply({ ok: false, error: 'Preview pages cannot change preview sessions' });
    return;
  }

  if (data.type === 'html-viewer:touch-project') {
    const sessionId = String(data.sessionId || '');
    if (!sessionId) {
      reply({ ok: false, error: 'Sesión de preview no válida' });
      return;
    }

    const touchSession = enqueueSessionUpdate(sessionId, async () => {
      const session = await getOrRestoreSession(sessionId);
      if (!session) {
        reply({ ok: true, found: false, version: 0 });
        return;
      }

      session.updatedAt = Date.now();
      schedulePersistentSessionWrite(sessionId);
      reply({ ok: true, found: true, version: session.version, count: session.files.size });
    });
    event.waitUntil(touchSession.then(() => sessionPersistenceStates.get(sessionId)?.promise));
    return;
  }

  if (data.type !== 'html-viewer:set-project') return;

  const sessionId = String(data.sessionId || '');
  const incomingVersion = Number(data.version);
  if (!sessionId || !Number.isFinite(incomingVersion) || incomingVersion <= 0) {
    reply({ ok: false, error: 'Sesión o versión de preview no válida' });
    return;
  }

  const updateSession = enqueueSessionUpdate(sessionId, async () => {
    try {
      pruneSessions();
      void prunePersistentSessions().catch(() => {});
      const restoredSession = await getOrRestoreSession(sessionId);
      if (!restoredSession && !data.full) {
        reply({ ok: true, missing: true, version: 0, count: 0 });
        return;
      }
      const session = restoredSession || getSession(sessionId);

      // Messages can outlive the render that created them. Applying a version
      // twice or applying an older one would resurrect stale files.
      if (incomingVersion <= session.version) {
        reply({ ok: true, stale: true, version: session.version, count: session.files.size });
        return;
      }

      if (data.full) {
        session.files.clear();
        session.pathIndex.clear();
      }

      session.siteRoot = normalizePath(data.siteRoot || session.siteRoot || '');

      for (const path of data.removedPaths || []) {
        const cleanPath = normalizePath(path);
        session.files.delete(cleanPath);
        session.pathIndex.delete(cleanPath.toLowerCase());
      }

      for (const entry of data.entries || []) {
        const path = normalizePath(entry.path);
        if (!path) continue;
        session.files.set(path, {
          path,
          mimeType: entry.mimeType || 'application/octet-stream',
          isBinary: Boolean(entry.isBinary),
          content: entry.content || '',
          blob: entry.blob || null
        });
        session.pathIndex.set(path.toLowerCase(), path);
      }

      session.version = incomingVersion;
      session.updatedAt = Date.now();
      schedulePersistentSessionWrite(sessionId);
      reply({ ok: true, version: session.version, count: session.files.size });
    } catch (err) {
      reply({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
  event.waitUntil(updateSession.then(() => sessionPersistenceStates.get(sessionId)?.promise));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Other origins (CDNs, fonts, APIs) stay on the network untouched.
  if (url.origin !== self.location.origin) return;
  const isNavigation = request.mode === 'navigate' || ['document', 'iframe', 'frame'].includes(request.destination);
  const readsFile = request.method === 'GET' || request.method === 'HEAD';

  const parsed = parseProjectUrl(url);
  if (parsed) {
    // A static host answers a form POST to a page with that page.
    if (!readsFile && !isNavigation) return;
    rememberProjectClient(event, parsed.sessionId);
    event.respondWith((async () => {
      const session = await getOrRestoreSession(parsed.sessionId);
      if (!session) return isNavigation ? responseForMissingSession(request) : responseForFile(null, request);
      const fileRequest = readsFile ? request : new Request(request.url);
      const route = resolveProjectRequestWithSpaFallback(session, parsed.path || 'index.html', request);
      return responseForResolvedRoute(route, fileRequest, parsed.sessionId, url);
    })());
    return;
  }

  if (!event.clientId || !readsFile) return;

  event.respondWith((async () => {
    const sessionId = await getSessionFromClient(event);
    if (!sessionId) return fetch(request);

    const session = await getOrRestoreSession(sessionId);
    if (!session) return fetch(request);

    // A previewed page addresses its files with published URLs (`/img/a.png`).
    // What the project lacks is a 404, as on a real host: the editor's own
    // files are never served to it.
    const rootRelativePath = normalizePath(decodePath(url.pathname));
    const route = resolveProjectRequestWithSpaFallback(session, rootRelativePath, request, { preferSiteRoot: true });
    if (route.file && isNavigation) {
      const siteRoot = normalizePath(session.siteRoot || '');
      const redirectPath = siteRoot && rootRelativePath && !rootRelativePath.toLowerCase().startsWith(`${siteRoot.toLowerCase()}/`)
        ? joinPath(siteRoot, rootRelativePath)
        : (rootRelativePath || siteRoot || route.path);
      return Response.redirect(getProjectUrl(sessionId, redirectPath, url), 302);
    }
    return responseForResolvedRoute(route, request, sessionId, url);
  })());
});
