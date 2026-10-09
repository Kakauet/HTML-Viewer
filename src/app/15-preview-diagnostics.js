const previewConsoleButton = document.getElementById('btn-preview-console');
const previewConsolePanel = document.getElementById('preview-console');
const previewConsoleList = document.getElementById('preview-console-list');
const previewConsoleBadge = document.getElementById('preview-console-badge');
const previewConsoleSummary = document.getElementById('preview-console-summary');
const previewConsoleClear = document.getElementById('btn-preview-console-clear');
const previewConsoleClose = document.getElementById('btn-preview-console-close');
const previewConsoleFilters = document.getElementById('preview-console-filters');
const previewConsoleResizer = document.getElementById('preview-console-resizer');
const previewDiagnostics = [];
let previewDiagnosticFilter = 'all';
const PREVIEW_CONSOLE_HEIGHT_KEY = 'html-viewer-preview-console-height';

function getDiagnosticLabel(type) {
  return ['error', 'warning', 'resource', 'route', 'cors'].includes(type) ? t(`diag_${type}`) : t('diag_generic');
}

function getDiagnosticHint(item) {
  return ['cors', 'route', 'resource'].includes(item.type) ? t(`diag_hint_${item.type}`) : '';
}

function getDiagnosticSummary(count) {
  if (!count) return t('console_none');
  return count === 1 ? t('console_count_one') : t('console_count_other', { count });
}

// Show project files by their project path instead of the internal virtual
// URL; srcdoc documents have no meaningful location of their own.
function formatDiagnosticLocation(value) {
  const text = String(value || '');
  if (!text || /^about:srcdoc/i.test(text)) return '';
  const projectPath = getProjectPreviewPathFromUrl(text);
  if (projectPath) return projectPath;
  if (/^blob:/i.test(text)) return '';
  // Files previews report their published URLs: show the site path.
  try {
    const url = new URL(text);
    if (url.origin === location.origin) return `${decodeUrlPathComponent(url.pathname)}${url.search}`;
  } catch {}
  return text;
}

function renderPreviewDiagnostics() {
  if (!previewConsoleList) return;
  const visible = previewDiagnostics.filter(item => previewDiagnosticFilter === 'all' || item.type === previewDiagnosticFilter);
  previewConsoleList.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'preview-console-empty';
    empty.textContent = previewDiagnostics.length ? t('console_empty_filtered') : t('console_empty');
    previewConsoleList.appendChild(empty);
  }
  visible.forEach(item => {
    const row = document.createElement('article');
    row.className = `preview-console-item is-${item.type}`;
    const heading = document.createElement('div');
    heading.className = 'preview-console-item-heading';
    const label = document.createElement('span');
    label.className = 'preview-console-kind';
    label.textContent = getDiagnosticLabel(item.type);
    const message = document.createElement('span');
    message.className = 'preview-console-message';
    message.textContent = item.message;
    heading.append(label, message);
    row.appendChild(heading);
    const locationText = formatDiagnosticLocation(item.resourceUrl || item.sourceUrl || item.url);
    if (locationText) {
      const location = document.createElement('div');
      location.className = 'preview-console-location';
      location.textContent = `${locationText}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ''}` : ''}`;
      location.title = item.resourceUrl || item.sourceUrl || item.url;
      row.appendChild(location);
    }
    const hintText = getDiagnosticHint(item);
    if (hintText) {
      const hint = document.createElement('div');
      hint.className = 'preview-console-hint';
      hint.textContent = hintText;
      row.appendChild(hint);
    }
    previewConsoleList.appendChild(row);
  });
  const count = previewDiagnostics.length;
  const summary = getDiagnosticSummary(count);
  previewConsoleSummary.textContent = summary;
  previewConsoleSummary.classList.toggle('has-issues', count > 0);
  previewConsoleBadge.hidden = count === 0;
  previewConsoleBadge.textContent = count > 99 ? '99+' : String(count);
  previewConsoleButton?.classList.toggle('has-diagnostics', count > 0);
  const buttonLabel = count ? t('console_button_title', { summary }) : t('console_open');
  previewConsoleButton?.setAttribute('title', buttonLabel);
  previewConsoleButton?.setAttribute('aria-label', buttonLabel);
  if (previewConsoleClear) previewConsoleClear.disabled = count === 0;
}

const clearPreviewDiagnosticsState = () => {
  previewDiagnostics.length = 0;
  renderPreviewDiagnostics();
};
window.clearPreviewDiagnostics = clearPreviewDiagnosticsState;

function setPreviewConsoleOpen(open, { restoreFocus = false } = {}) {
  if (!previewConsolePanel) return;
  previewConsolePanel.hidden = !open;
  previewConsoleButton?.setAttribute('aria-expanded', String(open));
  previewConsoleButton?.classList.toggle('active', open);
  if (!open && restoreFocus) previewConsoleButton?.focus({ preventScroll: true });
}

function getPreviewConsoleHeightLimits() {
  const container = document.getElementById('content-preview');
  const available = container?.getBoundingClientRect().height || 400;
  return { min: 128, max: Math.max(128, available - 96) };
}

function setPreviewConsoleHeight(height, { persist = false } = {}) {
  if (!previewConsolePanel) return;
  const { min, max } = getPreviewConsoleHeightLimits();
  const nextHeight = Math.round(Math.min(max, Math.max(min, Number(height) || 260)));
  previewConsolePanel.style.setProperty('--preview-console-height', `${nextHeight}px`);
  previewConsoleResizer?.setAttribute('aria-valuemin', String(min));
  previewConsoleResizer?.setAttribute('aria-valuemax', String(max));
  previewConsoleResizer?.setAttribute('aria-valuenow', String(nextHeight));
  if (persist) {
    try { localStorage.setItem(PREVIEW_CONSOLE_HEIGHT_KEY, String(nextHeight)); } catch {}
  }
}

function restorePreviewConsoleHeight() {
  let storedHeight = 260;
  try { storedHeight = Number(localStorage.getItem(PREVIEW_CONSOLE_HEIGHT_KEY)) || storedHeight; } catch {}
  setPreviewConsoleHeight(storedHeight);
}

if (previewConsoleResizer) {
  const updateConsoleResizeLine = event => {
    const rect = previewConsoleResizer.getBoundingClientRect();
    const lineHalfWidth = 40;
    const minX = lineHalfWidth;
    const maxX = Math.max(minX, rect.width - lineHalfWidth);
    const x = Math.max(minX, Math.min(maxX, event.clientX - rect.left));
    previewConsoleResizer.style.setProperty('--mouse-x', `${x}px`);
  };

  previewConsoleResizer.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    updateConsoleResizeLine(event);
    previewConsolePanel.classList.add('is-resizing');
    previewConsoleResizer.setPointerCapture(event.pointerId);
  });
  previewConsoleResizer.addEventListener('pointermove', event => {
    updateConsoleResizeLine(event);
    if (!previewConsoleResizer.hasPointerCapture(event.pointerId)) return;
    const container = document.getElementById('content-preview');
    if (!container) return;
    setPreviewConsoleHeight(container.getBoundingClientRect().bottom - event.clientY);
  });
  const stopConsoleResize = event => {
    if (!previewConsoleResizer.hasPointerCapture(event.pointerId)) return;
    previewConsoleResizer.releasePointerCapture(event.pointerId);
    previewConsolePanel.classList.remove('is-resizing');
    setPreviewConsoleHeight(parseFloat(getComputedStyle(previewConsolePanel).height), { persist: true });
  };
  previewConsoleResizer.addEventListener('pointerup', stopConsoleResize);
  previewConsoleResizer.addEventListener('pointercancel', stopConsoleResize);
  previewConsoleResizer.addEventListener('dblclick', () => setPreviewConsoleHeight(260, { persist: true }));
  previewConsoleResizer.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = parseFloat(getComputedStyle(previewConsolePanel).height) || 260;
    const { min, max } = getPreviewConsoleHeightLimits();
    const next = event.key === 'Home' ? min : event.key === 'End' ? max : current + (event.key === 'ArrowUp' ? 24 : -24);
    setPreviewConsoleHeight(next, { persist: true });
  });
}
window.addEventListener('resize', () => setPreviewConsoleHeight(parseFloat(getComputedStyle(previewConsolePanel).height) || 260));
restorePreviewConsoleHeight();

window.addEventListener('message', event => {
  const item = event.data;
  if (
    !item ||
    item.channel !== 'html-viewer-preview-diagnostic' ||
    event.source !== previewIframe?.contentWindow ||
    item.type === 'ready' ||
    String(item.renderToken || '') !== String(previewLifecycle.activeDiagnosticToken || '')
  ) return;
  const signature = [item.type, item.message, item.resourceUrl, item.sourceUrl, item.line].join('|');
  const previous = previewDiagnostics[previewDiagnostics.length - 1];
  if (previous?.signature === signature) {
    previous.repeats = (previous.repeats || 1) + 1;
    previous.message = `${String(item.message).replace(/ \(x\d+\)$/, '')} (x${previous.repeats})`;
  } else {
    previewDiagnostics.push({ ...item, signature });
    if (previewDiagnostics.length > 200) previewDiagnostics.shift();
  }
  renderPreviewDiagnostics();
});

previewConsoleButton?.addEventListener('click', () => setPreviewConsoleOpen(previewConsolePanel?.hidden));
previewConsoleClose?.addEventListener('click', () => setPreviewConsoleOpen(false, { restoreFocus: true }));
previewConsolePanel?.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  setPreviewConsoleOpen(false, { restoreFocus: true });
});
previewConsoleClear?.addEventListener('click', clearPreviewDiagnosticsState);
previewConsoleFilters?.addEventListener('click', event => {
  const button = event.target.closest('[data-diagnostic-filter]');
  if (!button) return;
  previewDiagnosticFilter = button.dataset.diagnosticFilter;
  previewConsoleFilters.querySelectorAll('button').forEach(item => {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  });
  renderPreviewDiagnostics();
});
renderPreviewDiagnostics();
