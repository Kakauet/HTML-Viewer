# App source layout

`index.html` loads the generated `app.bundle.js`. Edit these source files, then
run `node build.mjs` to regenerate and fingerprint the served bundle.

- `00-config-state.js`: constants, DOM handles, state, initial project data.
- `01-history.js`: undo/redo snapshots and text change tracking.
- `02-file-path-records.js`: path normalization, MIME helpers, file records.
- `03-project-preview-service-worker.js`: project preview service worker sync.
- `preview-worker-transport.js`: private registration/connection state, activation and message-port lifetime; shared registration promises and retry invalidation.
- `04-models-entry-utils.js`: Monaco models, entry file selection, small UI helpers.
- `05-reference-resolution.js`: Simple-mode reference rewriting and injection of the preview runtime.
- `05b-preview-runtime.js`: runtime script injected into every previewed HTML document, plus its editor-side helpers (storage namespaces, pruning).
- `06-virtual-assets.js`: Blob/Data URL snapshots and asset URL caches.
- `07-preview-editor.js`: preview rendering and editor bootstrapping.
- `08-layout-preview-controls.js`: split layout and preview toolbar controls.
- `09-import-export-theme.js`: modals, import/export, drag/drop, theme toggle.
- `10-editor-mode-assets.js`: unified/split mode and asset preview UI.
- `11-explorer-tabs.js`: file explorer, tabs, folder/file operations.
- `12-mobile-init.js`: mobile controls and final app initialization.
- `13-about-panel.js`: brief help panel and keyboard focus.
- `15-preview-diagnostics.js`: isolated diagnostics UI and token-filtered preview messages.
- `16-editor-recovery.js`: optional IndexedDB snapshot/recovery for editable work.

## Preview contracts

- `Simple` renders through `iframe.srcdoc`, remains debounce-free and coalesces
  an input burst to the newest generation once per animation frame.
- `previewLifecycle` is the single coordinator for mode, phase, route,
  generation, pending request and expected navigation. Navigation, edits,
  reloads and mode changes all invalidate or advance that same generation.
- A render may commit only while its generation and project-session generation
  are current. Service-worker versions are issued monotonically and become
  visible only after the current request is acknowledged.
- `Simple` documents normally run in an opaque origin. With a separate preview
  origin, Simple documents needing project assets use the project server too.
- Netlify builds use `DEPLOY_URL` as the preview origin, separate from
  `https://instantviewer.online`. `PREVIEW_ORIGIN` can explicitly select another
  HTTPS origin serving the same build at the same path. `preview-bridge.html`
  registers the worker there and passes project messages through a dedicated
  MessagePort. Imported code cannot access the editor's DOM or storage.
- Static copies without a preview origin retain the same-origin compatibility
  mode, which requires trusted projects. Runtime namespaces and worker stubs
  alone are not a security boundary. Blocked third-party workers fall back to
  the local worker with a visible trust notice. If all worker setup fails, the existing
  srcdoc compatibility fallback still applies; do not describe it as isolated
  when editor Blob URLs require `allow-same-origin`.
- Monaco is built from upstream ESM with esbuild, including every language and
  five local workers. Its classic browser output preserves `file://` editing
  without an AMD loader. Run `npm ci && npm run build` to reproduce the assets.
- `Archivos` syncs a virtual project to `preview-sw.js` under the scoped
  `__html_viewer_project__/` URL beneath the app's deployment path; the main application must never be controlled
  by that service worker.
- The project session id is reused across a full application reload when
  `sessionStorage` is available, preventing persistent-session growth while
  keeping storage optional.
- The project response layer preserves MIME types, byte ranges, `HEAD` requests,
  clean routes, root-relative assets, query strings, local `_redirects` rules
  and extensionless SPA fallbacks while leaving cross-origin requests on the
  network.
- Project files are served verbatim; nothing is rewritten. A page sees its
  published URL (`/servicios/`, `/#contacto`), because the runtime
  `replaceState`s away from the worker URL. Requests the project cannot answer
  are 404s from the project, never the editor's own files.
- The runtime (`htmlViewerPreviewRuntime`) is the only code injected into
  previewed pages. It maps links, forms, frames, `window.open` and
  `location.assign` to the project, scopes `localStorage`, `sessionStorage`,
  cookies, IndexedDB and CacheStorage to the project's namespace (pruned after
  7 days), stubs `navigator.serviceWorker`, and reports diagnostics and
  location over the `html-viewer-preview-diagnostic` / `-control` channels.
  It must not replace `fetch`, XHR or focus, nor suppress interactions.
- A reload or history traversal onto a published URL is not in the worker's
  scope: the runtime asks the editor to reload the page from the project, and
  the out-of-scope guard in the shell and `404.html` does the same for
  traversals that reach the network (`recover` navigations replace, link
  navigations push a history entry so `history.back()` works).
- Full page opens `preview.html`: a sandboxed host that frames the project
  session (`?session=&root=#/route`, history kept in the host's hash), or, for
  Simple documents, receives the document by `postMessage` and renders it in an
  opaque frame. The host drops `window.opener`.
- Browser preference storage is optional. The editor must still start when
  `localStorage` is unavailable or blocked.
