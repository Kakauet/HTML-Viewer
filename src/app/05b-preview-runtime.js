// Runtime injected as the first script of every previewed document.
//
// The function below is serialized with Function#toString, so it must stay
// self-contained: it may only use its `config` argument and browser globals.
// It runs in two contexts:
//
// - `document` (Simple, srcdoc): usually an opaque sandboxed origin. Storage
//   APIs that the sandbox blocks are replaced by in-memory equivalents whose
//   contents the editor persists under its own namespace.
// - `project` (Files, service worker): same origin as the editor, because the
//   worker can only serve same-origin clients. The page sees its own clean URL
//   (`/servicios/x` instead of the virtual worker path), gets storage that is
//   scoped to the project and cannot register service workers or reach the
//   editor's databases by accident. Local navigations are mapped back into the
//   worker namespace so every page of the site can be visited.
//
// fetch, XHR, focus and input events are never wrapped.
function htmlViewerPreviewRuntime(config) {
  'use strict';
  if (window.__htmlViewerRuntimeInstalled) return;
  try {
    Object.defineProperty(window, '__htmlViewerRuntimeInstalled', { value: true });
  } catch {
    return;
  }

  const DIAGNOSTIC_CHANNEL = 'html-viewer-preview-diagnostic';
  const CONTROL_CHANNEL = 'html-viewer-preview-control';
  const messages = config.messages || {};
  const initialUrl = new URL(location.href);
  const renderToken = initialUrl.searchParams.get(config.versionParam) || String(config.renderToken ?? '');
  let embeddingFrame = null;
  const parentOrigin = location.ancestorOrigins?.[0];
  if (config.mode === 'project' && (!config.separateOrigin || !parentOrigin || parentOrigin === location.origin)) {
    try { embeddingFrame = window.frameElement; } catch {}
  }
  // Only the document shown directly by the editor (or the full-page host)
  // adopts clean URLs and delegates its navigations; nested frames and pages
  // opened at top level keep the worker URL, which survives a reload.
  const isPreviewRoot = Boolean(embeddingFrame?.hasAttribute?.('data-html-viewer-preview')) ||
    Boolean(config.separateOrigin && window.parent !== window && !embeddingFrame);

  const define = (target, name, descriptor) => {
    try {
      Object.defineProperty(target, name, { configurable: true, enumerable: true, ...descriptor });
      return true;
    } catch {
      return false;
    }
  };
  const post = (channel, type, details = {}) => {
    try {
      if (window.parent !== window) {
        window.parent.postMessage({ channel, type, renderToken, url: location.href,
          runtime: window.__htmlViewerPreview || null, time: Date.now(), ...details }, '*');
      }
    } catch {}
  };

  // --- Diagnostics -------------------------------------------------------
  const text = value => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  ['error', 'warn'].forEach(level => {
    const original = console[level];
    console[level] = function (...args) {
      post(DIAGNOSTIC_CHANNEL, level === 'error' ? 'error' : 'warning', { message: args.map(text).join(' '), source: 'console' });
      return original.apply(this, args);
    };
  });
  addEventListener('error', event => {
    const target = event.target;
    if (target && target !== window) {
      post(DIAGNOSTIC_CHANNEL, 'resource', {
        message: messages.resource,
        resourceUrl: target.currentSrc || target.src || target.href || target.data || '',
        tag: target.tagName || ''
      });
      return;
    }
    post(DIAGNOSTIC_CHANNEL, 'error', {
      message: text(event.message || messages.error),
      sourceUrl: event.filename || '',
      line: event.lineno || 0,
      column: event.colno || 0,
      stack: event.error?.stack || ''
    });
  }, true);
  addEventListener('unhandledrejection', event => {
    post(DIAGNOSTIC_CHANNEL, 'error', { message: text(event.reason || messages.rejection), source: 'promise' });
  });
  addEventListener('pointerdown', () => post(CONTROL_CHANNEL, 'interaction'), true);

  // --- Storage -----------------------------------------------------------
  const wrapStorage = (api, listKeys) => new Proxy(api, {
    get(target, property) {
      if (typeof property === 'symbol' || property in target) {
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const value = target.getItem(property);
      return value === null ? undefined : value;
    },
    set(target, property, value) {
      if (typeof property === 'symbol' || property in target) return Reflect.set(target, property, value);
      target.setItem(property, value);
      return true;
    },
    has(target, property) {
      return property in target || (typeof property === 'string' && target.getItem(property) !== null);
    },
    deleteProperty(target, property) {
      if (typeof property === 'string' && !(property in target)) target.removeItem(property);
      return true;
    },
    ownKeys() {
      return listKeys();
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property !== 'string' || property in target) return Reflect.getOwnPropertyDescriptor(target, property);
      const value = target.getItem(property);
      return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
    }
  });

  const createMemoryStorage = (initial, onChange) => {
    const map = new Map();
    Object.entries(initial || {}).forEach(([key, value]) => map.set(String(key), String(value)));
    const api = {
      getItem(key) { key = String(key); return map.has(key) ? map.get(key) : null; },
      setItem(key, value) { map.set(String(key), String(value)); onChange(); },
      removeItem(key) { if (map.delete(String(key))) onChange(); },
      clear() { if (map.size) { map.clear(); onChange(); } },
      key(index) { return Array.from(map.keys())[index] ?? null; },
      get length() { return map.size; }
    };
    return { storage: wrapStorage(api, () => Array.from(map.keys())), dump: () => Object.fromEntries(map) };
  };

  const createScopedStorage = (native, prefix) => {
    const keys = () => {
      const result = [];
      for (let index = 0; index < native.length; index += 1) {
        const key = native.key(index);
        if (key !== null && key.startsWith(prefix)) result.push(key.slice(prefix.length));
      }
      return result;
    };
    const api = {
      getItem(key) { return native.getItem(prefix + String(key)); },
      setItem(key, value) { native.setItem(prefix + String(key), String(value)); },
      removeItem(key) { native.removeItem(prefix + String(key)); },
      clear() { keys().forEach(key => native.removeItem(prefix + key)); },
      key(index) { return keys()[index] ?? null; },
      get length() { return keys().length; }
    };
    return wrapStorage(api, keys);
  };

  // A small cookie jar: name/value pairs with expiry. Domain, path and secure
  // attributes have no meaning for a local preview.
  const createCookieJar = (serialized, persist) => {
    const jar = new Map();
    try {
      for (const [name, value, expires] of JSON.parse(serialized || '[]')) {
        jar.set(String(name), { value: String(value), expires: expires === null ? null : Number(expires) });
      }
    } catch {}
    const purge = () => {
      const now = Date.now();
      for (const [name, cookie] of jar) if (cookie.expires !== null && cookie.expires <= now) jar.delete(name);
    };
    return {
      read() {
        purge();
        return Array.from(jar, ([name, cookie]) => (name ? `${name}=${cookie.value}` : cookie.value)).join('; ');
      },
      write(value) {
        const [pair = '', ...attributes] = String(value).split(';');
        const separator = pair.indexOf('=');
        const name = separator >= 0 ? pair.slice(0, separator).trim() : '';
        const cookieValue = separator >= 0 ? pair.slice(separator + 1).trim() : pair.trim();
        let expires = null;
        for (const attribute of attributes) {
          const index = attribute.indexOf('=');
          const key = (index >= 0 ? attribute.slice(0, index) : attribute).trim().toLowerCase();
          const attributeValue = index >= 0 ? attribute.slice(index + 1).trim() : '';
          if (key === 'max-age' && attributeValue !== '' && Number.isFinite(Number(attributeValue))) {
            expires = Date.now() + Number(attributeValue) * 1000;
          } else if (key === 'expires' && expires === null) {
            const time = Date.parse(attributeValue);
            if (!Number.isNaN(time)) expires = time;
          }
        }
        if (expires !== null && expires <= Date.now()) jar.delete(name);
        else jar.set(name, { value: cookieValue, expires });
        persist();
      },
      serialize() {
        purge();
        return JSON.stringify(Array.from(jar, ([name, cookie]) => [name, cookie.value, cookie.expires]));
      }
    };
  };

  let nativeStorage = null;
  try {
    nativeStorage = { local: window.localStorage, session: window.sessionStorage };
    nativeStorage.local.length;
  } catch {
    nativeStorage = null;
  }

  if (!nativeStorage) {
    // Opaque origin: the sandbox blocks storage. Pages still get working
    // Web Storage and cookies; the editor keeps them between renders.
    const snapshot = config.storage || {};
    let queued = false;
    let jar;
    const flush = () => {
      queued = false;
      post(CONTROL_CHANNEL, 'storage', { local: local.dump(), session: session.dump(), cookies: jar.serialize() });
    };
    const changed = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(flush);
    };
    const local = createMemoryStorage(snapshot.local, changed);
    const session = createMemoryStorage(snapshot.session, changed);
    jar = createCookieJar(snapshot.cookies, changed);
    define(window, 'localStorage', { get: () => local.storage });
    define(window, 'sessionStorage', { get: () => session.storage });
    define(document, 'cookie', { get: () => jar.read(), set: value => jar.write(value) });
  } else if (config.namespace) {
    const prefix = `__hv:${config.namespace}:`;
    const local = createScopedStorage(nativeStorage.local, prefix);
    const session = createScopedStorage(nativeStorage.session, prefix);
    const cookieKey = `__hvc:${config.namespace}`;
    let jar;
    jar = createCookieJar(nativeStorage.local.getItem(cookieKey), () => {
      try { nativeStorage.local.setItem(cookieKey, jar.serialize()); } catch {}
    });
    define(window, 'localStorage', { get: () => local });
    define(window, 'sessionStorage', { get: () => session });
    define(document, 'cookie', { get: () => jar.read(), set: value => jar.write(value) });

    try {
      const factory = window.indexedDB;
      const open = factory.open;
      const remove = factory.deleteDatabase;
      const list = factory.databases;
      define(factory, 'open', { writable: true, value(name, ...rest) { return open.call(factory, prefix + String(name), ...rest); } });
      define(factory, 'deleteDatabase', { writable: true, value(name, ...rest) { return remove.call(factory, prefix + String(name), ...rest); } });
      if (typeof list === 'function') {
        define(factory, 'databases', {
          writable: true,
          value() {
            return list.call(factory).then(items => items
              .filter(item => String(item.name).startsWith(prefix))
              .map(item => ({ ...item, name: item.name.slice(prefix.length) })));
          }
        });
      }
    } catch {}

    try {
      const cacheStorage = window.caches;
      const methods = {};
      ['open', 'has', 'delete', 'keys', 'match'].forEach(name => { methods[name] = cacheStorage[name]; });
      const ownNames = () => methods.keys.call(cacheStorage)
        .then(names => names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)));
      ['open', 'has', 'delete'].forEach(name => {
        define(cacheStorage, name, { writable: true, value(cacheName, ...rest) { return methods[name].call(cacheStorage, prefix + String(cacheName), ...rest); } });
      });
      define(cacheStorage, 'keys', { writable: true, value: ownNames });
      define(cacheStorage, 'match', {
        writable: true,
        async value(request, options = {}) {
          const names = options.cacheName !== undefined ? [String(options.cacheName)] : await ownNames();
          for (const name of names) {
            if (!(await methods.has.call(cacheStorage, prefix + name))) continue;
            const cache = await methods.open.call(cacheStorage, prefix + name);
            const response = await cache.match(request, options);
            if (response) return response;
          }
          return undefined;
        }
      });
    } catch {}
  }

  // The preview's own service worker serves the project. Pages must neither
  // replace it nor unregister it ("unregister all workers" snippets are
  // common), so they see a container without registrations.
  const unavailableWorkers = () => Promise.reject(new DOMException(messages.serviceWorker || 'Service workers are disabled in the preview.', 'SecurityError'));
  const workerContainer = {
    controller: null,
    ready: new Promise(() => {}),
    oncontrollerchange: null,
    onmessage: null,
    onmessageerror: null,
    register: unavailableWorkers,
    getRegistration: () => Promise.resolve(undefined),
    getRegistrations: () => Promise.resolve([]),
    startMessages() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; }
  };
  define(navigator, 'serviceWorker', { get: () => workerContainer });

  if (config.mode !== 'project') {
    post(DIAGNOSTIC_CHANNEL, 'ready', { message: 'preview-runtime-ready' });
    return;
  }

  // --- Project URLs ------------------------------------------------------
  const encodePath = value => String(value || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const namespaceRoot = `${config.appBase}${config.marker}/`;
  const sessionRoot = `${namespaceRoot}${encodeURIComponent(config.session)}/`;
  const encodedSiteRoot = encodePath(config.siteRoot);
  const siteBase = new URL(`${sessionRoot}${encodedSiteRoot ? `${encodedSiteRoot}/` : ''}`, location.origin);
  const hostPath = `${config.appBase}${config.hostPage}`;

  const resolve = value => {
    try { return new URL(String(value), document.baseURI); } catch { return null; }
  };
  const isNamespaced = url => url.pathname.startsWith(namespaceRoot);
  const withoutVersion = url => {
    const copy = new URL(url.href);
    copy.searchParams.delete(config.versionParam);
    return copy;
  };
  // Worker URL -> the URL the site would have when published.
  const toPretty = url => {
    if (!url.pathname.startsWith(sessionRoot)) return null;
    let rest = url.pathname.slice(sessionRoot.length);
    if (encodedSiteRoot) {
      if (rest.toLowerCase() === encodedSiteRoot.toLowerCase()) rest = '';
      else if (rest.toLowerCase().startsWith(`${encodedSiteRoot.toLowerCase()}/`)) rest = rest.slice(encodedSiteRoot.length + 1);
      else return null;
    }
    rest = rest.replace(/(^|\/)index\.html?$/i, '$1');
    const pretty = withoutVersion(new URL(`/${rest}`, location.origin));
    pretty.search = withoutVersion(url).search;
    pretty.hash = url.hash;
    return pretty;
  };
  const fromHost = url => (url.pathname === hostPath && url.hash.startsWith('#/') ? resolve(url.hash.slice(1)) : url);
  // Any same-origin URL -> the worker URL that serves it.
  const toProject = value => {
    let url = resolve(value);
    if (!url || url.origin !== location.origin) return null;
    url = fromHost(url);
    if (!url || isNamespaced(url)) return url?.href || null;
    const target = new URL(url.pathname.replace(/^\/+/, ''), siteBase);
    target.search = url.search;
    target.hash = url.hash;
    return target.href;
  };
  // Any same-origin URL -> the full-page host showing it in a new window.
  const toHost = value => {
    let url = resolve(value);
    if (!url || url.origin !== location.origin) return null;
    url = fromHost(url);
    const pretty = url && (isNamespaced(url) ? toPretty(url) : url);
    if (!pretty) return null;
    const host = new URL(hostPath, config.hostOrigin || location.origin);
    if (host.origin !== location.origin) host.searchParams.set('previewOrigin', location.origin);
    host.searchParams.set('session', config.session);
    if (config.siteRoot) host.searchParams.set('root', config.siteRoot);
    host.hash = `${pretty.pathname}${pretty.search}${pretty.hash}`;
    return host.href;
  };

  let prettyPathname = '';
  if (isPreviewRoot) {
    const pretty = toPretty(initialUrl);
    if (pretty) {
      prettyPathname = pretty.pathname;
      try { history.replaceState(history.state, '', pretty.href); } catch { prettyPathname = ''; }
    }
  }
  // Read by the editor, the full-page host and the out-of-scope guard pages.
  Object.defineProperty(window, '__htmlViewerPreview', {
    value: Object.freeze({
      session: String(config.session),
      siteRoot: String(config.siteRoot || ''),
      version: renderToken,
      sourceHref: initialUrl.href,
      prettyPathname,
      siteBase: siteBase.href
    })
  });

  // `href="#"` has an empty fragment but is still a same-document link.
  const sameDocument = url => url.href.includes('#') && url.href.split('#')[0] === location.href.split('#')[0];
  const targetKind = rawTarget => {
    const target = String(rawTarget ?? '').trim();
    const lower = target.toLowerCase();
    if (!target || lower === '_self') return 'self';
    if (lower === '_top' || lower === '_parent') return isPreviewRoot || window.parent === window ? 'self' : 'frame';
    if (lower === '_blank') return 'window';
    try {
      const name = CSS.escape(target);
      if (document.querySelector(`iframe[name="${name}"],frame[name="${name}"],object[name="${name}"]`)) return 'frame';
    } catch {}
    return 'window';
  };
  const baseTarget = () => document.querySelector('base[target]')?.getAttribute('target') || '';
  const navigateSelf = href => {
    if (isPreviewRoot) post(CONTROL_CHANNEL, 'navigate', { target: href });
    else location.assign(toProject(href) || href);
  };
  // Point an attribute at a mapped URL just for the default action that is
  // about to run, then restore what the page authored.
  const swapAttribute = (element, attribute, value) => {
    if (!value) return;
    const previous = element.getAttribute(attribute);
    if (previous === value) return;
    element.setAttribute(attribute, value);
    setTimeout(() => {
      if (element.getAttribute(attribute) !== value) return;
      if (previous === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, previous);
    }, 0);
  };

  const findLink = event => event.composedPath().find(node => (
    node?.nodeType === 1 && (node.localName === 'a' || node.localName === 'area') && node.hasAttribute('href')
  ));
  const handleLink = event => {
    const link = findLink(event);
    if (!link) return;
    // SVG links expose an animated value instead of a resolved string.
    const url = resolve(typeof link.href === 'string' ? link.href : link.getAttribute('href'));
    if (!url || url.origin !== location.origin) return;
    const kind = targetKind(link.getAttribute('target') ?? baseTarget());
    const opensElsewhere = event.type !== 'click' || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey;
    if (event.type === 'contextmenu' || link.hasAttribute('download')) {
      swapAttribute(link, 'href', link.hasAttribute('download') ? toProject(url.href) : (toHost(url.href) || toProject(url.href)));
      return;
    }
    if (event.defaultPrevented) return;
    if (opensElsewhere || kind === 'window') {
      swapAttribute(link, 'href', toHost(url.href) || toProject(url.href));
      return;
    }
    if (kind === 'frame') {
      swapAttribute(link, 'href', toProject(url.href));
      return;
    }
    if (sameDocument(url) || (!isPreviewRoot && isNamespaced(url))) return;
    event.preventDefault();
    navigateSelf(url.href);
  };
  // Bubble listeners on window run after the page's own handlers, so pages
  // that route their links themselves (SPAs, smooth scrolling) keep control.
  addEventListener('click', handleLink);
  addEventListener('auxclick', handleLink);
  addEventListener('contextmenu', handleLink, true);

  addEventListener('submit', event => {
    if (event.defaultPrevented) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter || null;
    const action = submitter?.getAttribute?.('formaction') ?? form.getAttribute('action');
    const url = resolve(action || location.href);
    if (!url || url.origin !== location.origin) return;
    const method = String(submitter?.getAttribute?.('formmethod') || form.getAttribute('method') || 'get').toLowerCase();
    if (method === 'dialog') return;
    const kind = targetKind(submitter?.getAttribute?.('formtarget') ?? form.getAttribute('target') ?? baseTarget());
    if (method === 'get' && kind !== 'frame' && (kind === 'window' || isPreviewRoot)) {
      event.preventDefault();
      const destination = new URL(url.href);
      destination.search = '';
      let data;
      try { data = new FormData(form, submitter || undefined); } catch { data = new FormData(form); }
      for (const [name, value] of data) if (typeof value === 'string') destination.searchParams.append(name, value);
      if (kind === 'window') window.open(destination.href, form.getAttribute('target') || '_blank');
      else navigateSelf(destination.href);
      return;
    }
    const element = submitter?.hasAttribute?.('formaction') ? submitter : form;
    swapAttribute(element, element === form ? 'action' : 'formaction', toProject(url.href));
  });

  const nativeOpen = window.open;
  define(window, 'open', {
    writable: true,
    value: function open(url, target, features) {
      const resolved = url === undefined || url === null || String(url) === '' ? null : resolve(url);
      if (resolved && resolved.origin === location.origin) {
        const kind = targetKind(target === undefined ? '_blank' : target);
        if (kind === 'self' && isPreviewRoot && !sameDocument(resolved)) {
          navigateSelf(resolved.href);
          return window;
        }
        url = kind === 'window' ? (toHost(resolved.href) || toProject(resolved.href)) : toProject(resolved.href);
      }
      return nativeOpen.call(window, url, target, features);
    }
  });

  // Embedded documents navigate on insertion, before any click could be
  // observed, so their URLs are mapped as soon as they appear.
  const frameAttributes = { IFRAME: 'src', FRAME: 'src', OBJECT: 'data', EMBED: 'src' };
  const mapFrame = element => {
    const attribute = frameAttributes[element.tagName];
    const value = attribute && element.getAttribute(attribute);
    if (!value || /^(?:about|data|blob|javascript):/i.test(value.trim())) return;
    const url = resolve(value);
    if (!url || url.origin !== location.origin || isNamespaced(url)) return;
    const mapped = toProject(url.href);
    if (mapped && mapped !== url.href) element.setAttribute(attribute, mapped);
  };
  const scan = node => {
    if (node.nodeType !== 1) return;
    mapFrame(node);
    node.querySelectorAll?.('iframe[src],frame[src],object[data],embed[src]').forEach(mapFrame);
  };
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') mapFrame(record.target);
      else record.addedNodes.forEach(scan);
    }
  }).observe(document.documentElement || document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'data']
  });

  if (isPreviewRoot) {
    const report = () => post(CONTROL_CHANNEL, 'location', { title: document.title });
    ['pushState', 'replaceState'].forEach(name => {
      const original = history[name];
      define(history, name, {
        writable: true,
        value: function (...args) {
          const result = original.apply(this, args);
          report();
          return result;
        }
      });
    });
    addEventListener('popstate', report);
    addEventListener('hashchange', report);
    addEventListener('DOMContentLoaded', report);
    // The browser would reload the published URL, which only the editor can
    // serve: ask it to reload the page from the project instead.
    try {
      window.navigation?.addEventListener('navigate', event => {
        if (event.navigationType !== 'reload' || !event.cancelable) return;
        event.preventDefault();
        navigateSelf(location.href);
      });
    } catch {}
  }

  post(DIAGNOSTIC_CHANNEL, 'ready', { message: 'preview-runtime-ready' });
}

// Storage that Simple previews created, kept under the editor's origin with a
// namespace pages cannot read directly. Bounded so a page cannot exhaust the
// editor's own quota.
const PREVIEW_DOCUMENT_STORAGE_NAMESPACE = 'simple';
const PREVIEW_DOCUMENT_STORAGE_LIMIT = 1024 * 1024;

function readPreviewDocumentStorage() {
  const snapshot = { local: {}, session: {}, cookies: '' };
  const prefix = `__hv:${PREVIEW_DOCUMENT_STORAGE_NAMESPACE}:`;
  const read = (storage, target) => {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) target[key.slice(prefix.length)] = storage.getItem(key);
    }
  };
  try { read(localStorage, snapshot.local); } catch {}
  try { read(sessionStorage, snapshot.session); } catch {}
  try { snapshot.cookies = localStorage.getItem(`__hvc:${PREVIEW_DOCUMENT_STORAGE_NAMESPACE}`) || ''; } catch {}
  return snapshot;
}

function writePreviewDocumentStorage(data) {
  const prefix = `__hv:${PREVIEW_DOCUMENT_STORAGE_NAMESPACE}:`;
  const areas = { local: data?.local, session: data?.session };
  let size = String(data?.cookies || '').length;
  for (const values of Object.values(areas)) {
    if (!values || typeof values !== 'object') return false;
    for (const [key, value] of Object.entries(values)) size += key.length + String(value).length;
  }
  if (size > PREVIEW_DOCUMENT_STORAGE_LIMIT) return false;
  const replace = (storage, values) => {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) && !Object.prototype.hasOwnProperty.call(values, key.slice(prefix.length))) storage.removeItem(key);
    }
    for (const [key, value] of Object.entries(values)) storage.setItem(prefix + key, String(value));
  };
  try {
    replace(localStorage, areas.local);
    replace(sessionStorage, areas.session);
    localStorage.setItem(`__hvc:${PREVIEW_DOCUMENT_STORAGE_NAMESPACE}`, String(data.cookies || '[]'));
    return true;
  } catch {
    return false;
  }
}

function getProjectPreviewStorageNamespace() {
  // One namespace per editor tab session and site root: a different project
  // starts with clean storage, the same one keeps it across reloads.
  const source = `${projectPreviewSessionId}|${getProjectPreviewSiteRootPath()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `p${(hash >>> 0).toString(36)}`;
}

function createPreviewRuntimeScript({ mode = 'document', renderToken = '' } = {}) {
  const config = {
    mode,
    separateOrigin: mode === 'project' && IS_REMOTE_PREVIEW,
    renderToken: String(renderToken ?? ''),
    versionParam: PROJECT_PREVIEW_VERSION_PARAM,
    marker: PROJECT_PREVIEW_PREFIX,
    appBase: new URL(APP_ROOT_URL).pathname,
    hostPage: PREVIEW_HOST_PAGE,
    hostOrigin: new URL(APP_ROOT_URL).origin,
    session: projectPreviewSessionId,
    siteRoot: mode === 'project' ? getProjectPreviewSiteRootPath() : '',
    namespace: mode === 'project' ? getProjectPreviewStorageNamespace() : PREVIEW_DOCUMENT_STORAGE_NAMESPACE,
    storage: mode === 'document' ? readPreviewDocumentStorage() : null,
    messages: {
      resource: t('diag_resource_failed'),
      error: t('diag_js_error'),
      rejection: t('diag_unhandled_rejection'),
      serviceWorker: t('diag_service_worker_disabled')
    }
  };
  // Only `<` inside the data is escaped (`<` is an operator in the source);
  // the source can still not close the element.
  const data = JSON.stringify(config).replace(/</g, '\\u003c');
  const source = `(${htmlViewerPreviewRuntime.toString()})(${data});`.replace(/<(?=\/script|!--)/gi, '\\x3c');
  return `<script data-html-viewer-runtime>${source}</script>`;
}

// Namespaces of earlier sessions are removed after the same period the
// preview worker keeps its sessions.
function prunePreviewStorageNamespaces() {
  const registryKey = 'html-viewer:preview-storage';
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let registry = {};
  try { registry = JSON.parse(localStorage.getItem(registryKey) || '{}') || {}; } catch {}
  const current = getProjectPreviewStorageNamespace();
  registry[current] = now;
  const expired = Object.keys(registry).filter(namespace => namespace !== PREVIEW_DOCUMENT_STORAGE_NAMESPACE && now - Number(registry[namespace]) > maxAge);
  expired.forEach(namespace => delete registry[namespace]);
  try {
    localStorage.setItem(registryKey, JSON.stringify(registry));
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index) || '';
        const match = /^__hvc?:([^:]+)/.exec(key);
        if (match && expired.includes(match[1])) storage.removeItem(key);
      }
    }
  } catch {}
  if (!expired.length) return;
  const isExpired = name => expired.some(namespace => String(name).startsWith(`__hv:${namespace}:`));
  indexedDB?.databases?.().then(list => list.forEach(item => {
    if (isExpired(item.name)) indexedDB.deleteDatabase(item.name);
  })).catch(() => {});
  window.caches?.keys().then(names => names.forEach(name => {
    if (isExpired(name)) caches.delete(name);
  })).catch(() => {});
}
