// Switch editor mode (unified <-> split)
async function switchEditorMode(newMode, migrate = true, { render = true } = {}) {
  if (editorMode === newMode) return;
  if (!isRestoringHistory) window.cancelPendingRecovery?.();
  // Invalidate delayed work from the previous renderer before changing any
  // models or virtual files. A late Files render must never replace Simple,
  // and vice versa.
  invalidatePreviewLifecycle('mode-change');
  previewLifecycle.sessionGeneration += 1;
  resetProjectPreviewLocation();
  markProjectPreviewDirty(null, { all: true });
  if (!isRestoringHistory) {
    saveHistoryState();
  }

  const oldMode = editorMode;
  editorMode = newMode;

  const btnUnified = document.getElementById('btn-mode-unified');
  const btnSplit = document.getElementById('btn-mode-split');
  const activeFileSummary = document.getElementById('active-file-summary');
  const panelTitle = document.getElementById('editor-panel-title');
  const fileExplorer = document.getElementById('file-explorer');
  const btnToggleExplorer = document.getElementById('btn-toggle-explorer');

  // Update UI buttons and header elements state
  if (editorMode === 'unified') {
    btnUnified.classList.add('active');
    btnSplit.classList.remove('active');
    if (activeFileSummary) activeFileSummary.style.display = 'none';
    if (fileExplorer) fileExplorer.style.display = 'none';
    if (btnToggleExplorer) {
      btnToggleExplorer.style.display = 'none';
      btnToggleExplorer.classList.remove('active');
    }
    if (panelTitle) panelTitle.style.display = 'flex';
  } else {
    if (window.innerWidth <= 768) {
      isExplorerCollapsed = true;
    }
    btnUnified.classList.remove('active');
    btnSplit.classList.add('active');
    if (activeFileSummary) activeFileSummary.style.display = 'flex';
    if (fileExplorer) {
      fileExplorer.style.display = isExplorerCollapsed ? 'none' : 'flex';
    }
    if (btnToggleExplorer) {
      btnToggleExplorer.style.display = 'flex';
      if (isExplorerCollapsed) btnToggleExplorer.classList.remove('active');
      else btnToggleExplorer.classList.add('active');
    }
    if (panelTitle) panelTitle.style.display = 'none';
  }
  renderActiveFileSummary();
  if (typeof updateSidebarTexts === 'function') {
    updateSidebarTexts();
  }

  // Handle value migrations
  if (migrate) {
    const wasRestoring = isRestoringHistory;
    isRestoringHistory = true;
    try {
      if (oldMode === 'unified' && editorMode === 'split') {
        // Migrate Unified -> Split
        const unifiedVal = getCurrentEditorDocumentText();
        if (cameFromSplitMode) {
          const entryFile = getEntryFile();
          if (entryFile) {
            if (monacoLoaded) {
              if (fileModels[entryFile.id]) {
                fileModels[entryFile.id].setValue(unifiedVal);
              } else {
                entryFile.content = unifiedVal;
                entryFile.size = new Blob([unifiedVal]).size;
                markProjectPreviewDirty(entryFile.name);
              }
              syncModelsForFiles();
            } else {
              entryFile.content = unifiedVal;
              entryFile.size = new Blob([unifiedVal]).size;
              fallbackLastKnownValue = unifiedVal;
              markProjectPreviewDirty(entryFile.name);
            }
            openFile(entryFile.id);
          }
          cameFromSplitMode = false;
        } else {
          replaceProjectWithSplitSource(unifiedVal);

          if (monacoLoaded) {
            disposeAllFileModels();
            syncModelsForFiles();
          }

          openFile('1');
        }
      } else if (oldMode === 'split' && editorMode === 'unified') {
        // Migrate Split -> Unified
        cameFromSplitMode = true;
        saveFallbackTabContent();
        const entryFile = getEntryFile();
        const unifiedVal = entryFile ? getFileText(entryFile) : '';

        if (monacoLoaded) {
          unifiedModel.setValue(unifiedVal);
          editor.setModel(unifiedModel);
        } else {
          fallbackTextarea.value = unifiedVal;
          fallbackLastKnownValue = unifiedVal;
        }

        if (entryFile && filenameInput) {
          let name = getBaseName(entryFile.name);
          if (name.toLowerCase().endsWith('.html')) name = name.substring(0, name.length - 5);
          else if (name.toLowerCase().endsWith('.htm')) name = name.substring(0, name.length - 4);
          filenameInput.value = name || 'index';
          adjustFilenameWidth();
        }
      }
    } finally {
      isRestoringHistory = wasRestoring;
    }
  }

  // Update editor file name input extension
  updateEntryHtmlSelector();
  updateFileNameExtension();

  // Re-layout and render
  updateEditorPlaceholder();
  if (render) updatePreview();
  if (monacoLoaded && editor) {
    if (window.innerWidth > COMPACT_LAYOUT_MAX_WIDTH) {
      editor.focus();
    }
    queueEditorLayout();
    // Also queue a layout update after transition completes
    setTimeout(() => {
      if (editor && typeof editor.layout === 'function') {
        editor.layout();
      }
    }, 250);
  }
}

// Function to save fallback tab content in memory
function saveFallbackTabContent(fileId = activeFileId) {
  if (monacoLoaded) return;
  let targetFileId = fileId;
  if (editorMode === 'unified') {
    const entryFile = getEntryFile();
    if (entryFile) {
      targetFileId = entryFile.id;
    }
  }
  if (!targetFileId) return;
  const file = files.find(f => f.id === targetFileId);
  if (isEditableFile(file)) {
    const nextContent = fallbackTextarea.value;
    if (file.content !== nextContent) {
      file.content = nextContent;
      file.size = new Blob([file.content]).size;
      fallbackLastKnownValue = nextContent;
      markProjectPreviewDirty(file.name);
    }
  }
}

function createImageZoomViewer(file) {
  const viewport = document.createElement('div');
  viewport.className = 'asset-image-viewport';
  viewport.tabIndex = 0;

  const image = document.createElement('img');
  image.className = 'asset-preview-image';
  image.src = activeAssetPreviewUrl;
  image.alt = getBaseName(file.name);
  image.draggable = false;

  const controls = document.createElement('div');
  controls.className = 'asset-zoom-controls';
  controls.innerHTML = `
    <button type="button" class="asset-zoom-btn" data-zoom-action="out" title="${escapeHtml(t('zoom_out'))}" aria-label="${escapeHtml(t('zoom_out'))}"><i data-lucide="minus"></i></button>
    <button type="button" class="asset-zoom-btn asset-zoom-value" data-zoom-action="reset" title="${escapeHtml(t('zoom_reset'))}" aria-label="${escapeHtml(t('zoom_reset'))}">100%</button>
    <button type="button" class="asset-zoom-btn" data-zoom-action="in" title="${escapeHtml(t('zoom_in'))}" aria-label="${escapeHtml(t('zoom_in'))}"><i data-lucide="plus"></i></button>
  `;

  viewport.append(image, controls);

  const state = {
    scale: 1,
    x: 0,
    y: 0,
    minScale: 0.1,
    maxScale: 12,
    dragging: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0
  };

  const zoomValue = controls.querySelector('.asset-zoom-value');

  function applyTransform() {
    image.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.scale})`;
    if (zoomValue) zoomValue.textContent = `${Math.round(state.scale * 100)}%`;
    viewport.classList.toggle('is-zoomed', state.scale !== 1 || state.x !== 0 || state.y !== 0);
  }

  function clampScale(value) {
    return Math.min(state.maxScale, Math.max(state.minScale, value));
  }

  function zoomAt(nextScale, clientX = null, clientY = null) {
    const previousScale = state.scale;
    const newScale = clampScale(nextScale);
    if (newScale === previousScale) return;

    if (clientX !== null && clientY !== null) {
      const rect = viewport.getBoundingClientRect();
      const centerX = clientX - rect.left - rect.width / 2;
      const centerY = clientY - rect.top - rect.height / 2;
      const ratio = newScale / previousScale;
      state.x = centerX - (centerX - state.x) * ratio;
      state.y = centerY - (centerY - state.y) * ratio;
    }

    state.scale = newScale;
    if (Math.abs(state.scale - 1) < 0.001) {
      state.scale = 1;
      state.x = 0;
      state.y = 0;
    }
    applyTransform();
  }

  function resetZoom() {
    state.scale = 1;
    state.x = 0;
    state.y = 0;
    applyTransform();
  }

  controls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-zoom-action]');
    if (!button) return;
    const action = button.dataset.zoomAction;
    if (action === 'in') zoomAt(state.scale * 1.25);
    if (action === 'out') zoomAt(state.scale / 1.25);
    if (action === 'reset') resetZoom();
  });
  controls.addEventListener('pointerdown', event => event.stopPropagation());

  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    const zoomFactor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(state.scale * zoomFactor, event.clientX, event.clientY);
  }, { passive: false });

  viewport.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.asset-zoom-controls')) return;
    if (event.button !== 0) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    state.dragging = true;
    state.pointerId = event.pointerId;
    state.startX = event.clientX;
    state.startY = event.clientY;
    state.originX = state.x;
    state.originY = state.y;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
  });

  viewport.addEventListener('pointermove', (event) => {
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    state.x = state.originX + event.clientX - state.startX;
    state.y = state.originY + event.clientY - state.startY;
    applyTransform();
  });

  function stopPan(event) {
    if (event.pointerId !== state.pointerId) return;
    state.dragging = false;
    state.pointerId = null;
    viewport.classList.remove('is-panning');
  }

  viewport.addEventListener('pointerup', stopPan);
  viewport.addEventListener('pointercancel', stopPan);
  viewport.addEventListener('dblclick', resetZoom);
  viewport.addEventListener('dragstart', event => event.preventDefault());
  viewport.addEventListener('keydown', (event) => {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomAt(state.scale * 1.25);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomAt(state.scale / 1.25);
    } else if (event.key === '0' || event.key === 'Escape') {
      event.preventDefault();
      resetZoom();
    }
  });

  applyTransform();
  return {
    element: viewport,
    destroy() {
      activeImageZoomController = null;
    }
  };
}

function showCodeEditor() {
  const editorContainer = document.getElementById('editor-container');
  const assetPreviewPanel = document.getElementById('asset-preview-panel');
  if (activeImageZoomController) {
    activeImageZoomController.destroy();
    activeImageZoomController = null;
  }
  if (activeAssetPreviewUrl) {
    URL.revokeObjectURL(activeAssetPreviewUrl);
    activeAssetPreviewUrl = '';
  }
  if (editorContainer) editorContainer.style.display = 'block';
  if (assetPreviewPanel) assetPreviewPanel.style.display = 'none';
}

function showAssetPreview(file) {
  const editorContainer = document.getElementById('editor-container');
  const assetPreviewPanel = document.getElementById('asset-preview-panel');
  const stage = document.getElementById('asset-preview-stage');
  const nameEl = document.getElementById('asset-preview-name');
  const metaEl = document.getElementById('asset-preview-meta');
  const copyImgBtn = document.getElementById('btn-copy-asset-img');
  if (!assetPreviewPanel || !stage) return;

  if (activeAssetPreviewUrl) {
    URL.revokeObjectURL(activeAssetPreviewUrl);
  }
  if (activeImageZoomController) {
    activeImageZoomController.destroy();
    activeImageZoomController = null;
  }
  activeAssetPreviewUrl = URL.createObjectURL(getFileBlob(file));

  if (editorContainer) editorContainer.style.display = 'none';
  assetPreviewPanel.style.display = 'flex';
  stage.innerHTML = '';

  const ext = getFileExtension(file.name);
  stage.classList.toggle('is-image-preview', IMAGE_EXTENSIONS.has(ext));
  if (IMAGE_EXTENSIONS.has(ext)) {
    activeImageZoomController = createImageZoomViewer(file);
    stage.appendChild(activeImageZoomController.element);
    if (copyImgBtn) copyImgBtn.disabled = false;
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = activeAssetPreviewUrl;
    stage.appendChild(audio);
    if (copyImgBtn) copyImgBtn.disabled = true;
  } else if (VIDEO_EXTENSIONS.has(ext)) {
    const video = document.createElement('video');
    video.controls = true;
    video.src = activeAssetPreviewUrl;
    stage.appendChild(video);
    if (copyImgBtn) copyImgBtn.disabled = true;
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'asset-preview-placeholder';
    placeholder.innerHTML = `<i data-lucide="${getIconForFilename(file.name)}"></i><span>${escapeHtml(ext.toUpperCase() || 'ASSET')}</span>`;
    stage.appendChild(placeholder);
    if (copyImgBtn) copyImgBtn.disabled = true;
  }

  if (nameEl) nameEl.textContent = getBaseName(file.name);
  if (metaEl) metaEl.textContent = `${file.mimeType || getMimeTypeForFilename(file.name)} · ${formatBytes(file.size)}`;

  if (window.lucide) {
    lucide.createIcons();
  }
}

async function copyToClipboard(text, successMessage) {
  let fallbackTextarea = null;
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackTextarea = document.createElement('textarea');
      fallbackTextarea.value = text;
      fallbackTextarea.setAttribute('readonly', '');
      fallbackTextarea.style.position = 'fixed';
      fallbackTextarea.style.opacity = '0';
      document.body.appendChild(fallbackTextarea);
      fallbackTextarea.select();
      const copied = document.execCommand('copy');
      if (!copied) throw new Error('Clipboard unavailable');
    }
    showToast(successMessage);
  } catch {
    showToast(t('toast_clipboard_error'), 'error');
  } finally {
    fallbackTextarea?.remove();
  }
}

// Paths are copied relative to the entry HTML so they resolve when pasted
// there (the stored path also contains the project's root folder).
function getAssetReferencePath(file) {
  const entryFile = getEntryFile();
  return entryFile && entryFile.id !== file.id ? makeRelativePath(entryFile.name, file.name) : getBaseName(file.name);
}

function initAssetPreviewActions() {
  const copyPathBtn = document.getElementById('btn-copy-asset-path');
  const copyImgBtn = document.getElementById('btn-copy-asset-img');
  const copyCssBtn = document.getElementById('btn-copy-asset-css');

  if (copyPathBtn) {
    copyPathBtn.addEventListener('click', () => {
      const file = files.find(f => f.id === activeFileId);
      if (file && !file.isFolder) copyToClipboard(getAssetReferencePath(file), t('toast_path_copied'));
    });
  }

  if (copyImgBtn) {
    copyImgBtn.addEventListener('click', () => {
      const file = files.find(f => f.id === activeFileId);
      if (file && IMAGE_EXTENSIONS.has(getFileExtension(file.name))) {
        copyToClipboard(`<img src="${escapeHtml(getAssetReferencePath(file))}" alt="">`, t('toast_img_tag_copied'));
      }
    });
  }

  if (copyCssBtn) {
    copyCssBtn.addEventListener('click', () => {
      const file = files.find(f => f.id === activeFileId);
      if (file && !file.isFolder) copyToClipboard(`url("${getAssetReferencePath(file).replace(/"/g, '\\"')}")`, t('toast_css_url_copied'));
    });
  }
}

// Open a file in the editor and remember it in the recent-file stack.
function openFile(fileId, { autoCollapse = true } = {}) {
  if (typingSessionActive) {
    typingSessionActive = false;
    if (typingDebounceTimeout) clearTimeout(typingDebounceTimeout);
  }
  const file = files.find(f => f.id === fileId);
  if (!file || file.isFolder) return;

  const previousActiveId = activeFileId;
  if (!monacoLoaded && previousActiveId !== fileId) {
    saveFallbackTabContent(previousActiveId);
  }

  activeFileId = fileId;

  // Keep a lightweight recent-file stack for history and deletion fallback.
  if (!openFileIds.includes(fileId)) {
    openFileIds.push(fileId);
  }

  if (isEditableFile(file)) {
    showCodeEditor();
    // Switch Monaco Model
    if (monacoLoaded) {
      const model = fileModels[fileId] || createModelForFile(file);
      editor.setModel(model);
    } else {
      fallbackTextarea.value = file.content || '';
      fallbackLastKnownValue = fallbackTextarea.value;
    }
  } else {
    showAssetPreview(file);
    if (monacoLoaded) {
      editor.setModel(null);
    } else {
      fallbackTextarea.value = '';
      fallbackLastKnownValue = '';
    }
  }

  // Refresh the active-file summary and file chooser.
  renderActiveFileSummary();
  renderFileExplorer();
  updateFileNameExtension();
  updateEditorPlaceholder();

  if (monacoLoaded && editor && isEditableFile(file)) {
    if (window.innerWidth > COMPACT_LAYOUT_MAX_WIDTH) {
      editor.focus();
    }
    queueEditorLayout();
  }

  // Auto-collapse explorer on mobile when opening a file
  if (autoCollapse && window.innerWidth <= 768 && !isExplorerCollapsed) {
    toggleFileExplorer(false);
  }
}

// Remove a file from the recent-file stack (used when deleting files).
function closeFile(fileId, event) {
  if (typingSessionActive) {
    typingSessionActive = false;
    if (typingDebounceTimeout) clearTimeout(typingDebounceTimeout);
  }
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }

  // Remove from open file tabs list
  openFileIds = openFileIds.filter(id => id !== fileId);

  // If the closed tab was the active one, choose another tab to focus
  if (activeFileId === fileId) {
    if (openFileIds.length > 0) {
      openFile(openFileIds[openFileIds.length - 1]);
    } else {
      activeFileId = '';
      if (monacoLoaded) {
        editor.setModel(null);
      } else {
        fallbackTextarea.value = '';
        fallbackLastKnownValue = '';
      }
    }
  }

  renderActiveFileSummary();
  renderFileExplorer();
  updateFileNameExtension();
  updateEditorPlaceholder();
}
