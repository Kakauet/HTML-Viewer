// --- Modal & Project Import/Export Helpers ---
let modalReturnFocus = null;

function getModalFocusableElements(modal) {
  return Array.from(modal.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])'))
    .filter(element => !element.disabled && element.offsetParent !== null);
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.style.display = 'flex';
  modal.offsetHeight; // Force reflow
  modal.classList.add('active');

  if (window.lucide) {
    lucide.createIcons();
  }

  // Check showDirectoryPicker compatibility for export modal
  if (modalId === 'modal-export') {
    const isSupported = typeof window.showDirectoryPicker === 'function';
    const folderOpt = document.getElementById('btn-export-folder-opt');
    const badge = document.getElementById('folder-export-compatibility');
    if (folderOpt && badge) {
      if (!isSupported) {
        folderOpt.disabled = true;
        badge.style.display = 'inline-block';
      } else {
        folderOpt.disabled = false;
        badge.style.display = 'none';
      }
    }
  }

  const [firstFocusable] = getModalFocusableElements(modal.querySelector('.modal-body') || modal);
  (firstFocusable || modal.querySelector('.modal-close-btn'))?.focus({ preventScroll: true });
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal || !modal.classList.contains('active')) return;
  modal.classList.remove('active');
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;
  if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) {
    returnFocus.focus({ preventScroll: true });
  } else if (monacoLoaded && editor) {
    editor.focus();
  }
  setTimeout(() => {
    if (!modal.classList.contains('active')) {
      modal.style.display = 'none';
    }
  }, 220);
}

function initModalCloseEvents() {
  const modal = document.getElementById('modal-export');
  if (!modal) return;

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal('modal-export');
    }
  });

  const closeBtn = document.getElementById('modal-export-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      closeModal('modal-export');
    });
  }

  modal.addEventListener('keydown', (event) => {
    if (!modal.classList.contains('active')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeModal('modal-export');
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = getModalFocusableElements(modal);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function startImportOperation() {
  importGeneration += 1;
  window.cancelPendingRecovery?.();
  return importGeneration;
}

function cancelPendingImportOperations() {
  importGeneration += 1;
}

// Expose only the cancellation hook used by the editor input handlers.  The
// operation itself remains internal to this module.
window.cancelPendingImportOperations = cancelPendingImportOperations;

function beginProjectReplacement(importToken = null) {
  if (importToken !== null && importToken !== importGeneration) return false;
  if (importToken === null) importGeneration += 1;
  window.cancelPendingRecovery?.();
  projectIdentity += 1;
  invalidatePreviewLifecycle('project-replacement');
  previewLifecycle.sessionGeneration += 1;
  projectPreviewKnownPaths = new Set();
  projectPreviewSiteRoot = '';
  projectPreviewNeedsFullSync = true;
  projectPreviewLastUrl = '';
  projectPreviewMissingPath = '';
  projectPreviewNotifiedMissingPath = '';
  resetProjectPreviewLocation();
  return true;
}

function loadProjectFiles(newFiles, toastMessage = '', projectName = '', options = {}) {
  if (newFiles.length === 0) return;
  saveHistoryState();
  if (!beginProjectReplacement(options.importToken ?? null)) return false;
  const wasRestoring = isRestoringHistory;
  isRestoringHistory = true;
  try {
    switchEditorMode('split', false, { render: false });
    disposeAllFileModels();

    let cleanProjectName = projectName ? projectName.replace(/[\\/:*?"<>|]/g, '_').trim() : '';

    // 1. Check if there is already a single top-level directory segment in all newFiles
    let commonPrefix = '';
    let isFirst = true;
    let hasCommonPrefix = true;
    for (const file of newFiles) {
      const name = file.name.replace(/\\/g, '/');
      const firstSlash = name.indexOf('/');
      if (firstSlash === -1) {
        hasCommonPrefix = false;
        break;
      }
      const prefix = name.substring(0, firstSlash + 1);
      if (isFirst) {
        commonPrefix = prefix;
        isFirst = false;
      } else if (commonPrefix !== prefix) {
        hasCommonPrefix = false;
        break;
      }
    }

    // 2. Map paths to ensure they are inside the target root folder
    if (cleanProjectName) {
      const newPrefix = cleanProjectName + '/';
      newFiles.forEach(file => {
        const name = file.name.replace(/\\/g, '/');
        if (hasCommonPrefix && name.startsWith(commonPrefix)) {
          file.name = newPrefix + name.substring(commonPrefix.length);
        } else {
          file.name = newPrefix + name;
        }
      });
    } else {
      // If no project name was specified, check if they already have a common prefix.
      // If they don't, put them under 'proyecto-importado/'.
      if (!hasCommonPrefix) {
        const newPrefix = t('imported_project_name') + '/';
        newFiles.forEach(file => {
          const name = file.name.replace(/\\/g, '/');
          file.name = newPrefix + name;
        });
      }
    }

    files = newFiles.map(normalizeFileRecord);
    normalizeProjectFiles();
    syncModelsForFiles();

    selectedEntryFileId = '';
    const entryFile = getEntryFile();
    if (entryFile && isHtmlFile(entryFile)) {
      selectedEntryFileId = entryFile.id;
    }
    collapseLargeProjectFolders(entryFile);
    if (entryFile) {
      openFileIds = [entryFile.id];
      openFile(entryFile.id);
    } else {
      openFileIds = [];
      activeFileId = '';
      if (monacoLoaded && editor) {
        editor.setModel(null);
      } else if (fallbackTextarea) {
        fallbackTextarea.value = '';
      }
      renderActiveFileSummary();
      renderFileExplorer();
      updateEditorPlaceholder();
    }
  } finally {
    isRestoringHistory = wasRestoring;
  }

  const committedEntry = getEntryFile();
  updatePreview({
    force: true,
    full: true,
    forceNavigation: true,
    reason: 'project-replacement',
    targetPath: committedEntry?.name || ''
  });
  window.scheduleRecoverySave?.();
  if (toastMessage) {
    showToast(toastMessage);
  }
  return true;
}

function addFilesToProject(newFiles, targetPath = '') {
  if (newFiles.length === 0) return;
  saveHistoryState();
  const wasRestoring = isRestoringHistory;
  isRestoringHistory = true;
  try {
    if (editorMode !== 'split') {
      switchEditorMode('split', true);
    }

    newFiles.forEach(file => {
      let desiredPath;
      if (targetPath) {
        desiredPath = joinProjectPath(targetPath, getBaseName(file.name), { folder: file.isFolder });
      } else {
        const rootFolder = getProjectRootFolder();
        if (file.name.startsWith(rootFolder)) {
          desiredPath = file.name;
        } else {
          desiredPath = joinProjectPath(rootFolder, file.name, { folder: file.isFolder });
        }
      }
      file.name = getUniquePath(desiredPath, null, { folder: Boolean(file.isFolder) });
      normalizeFileRecord(file);
      files.push(file);
      if (!file.isFolder) {
        ensureParentFoldersForPath(file.name);
      }
    });

    normalizeProjectFiles();
    syncSelectedEntryFile();
    collapseLargeProjectFolders(getEntryFile());
    syncModelsForFiles();
    const firstFile = newFiles.find(file => !file.isFolder);
    if (firstFile) openFile(firstFile.id);
  } finally {
    isRestoringHistory = wasRestoring;
  }
  renderFileExplorer();
  renderActiveFileSummary();
  updatePreview();
  window.scheduleRecoverySave?.();
}

async function compileToUnifiedHTML() {
  const revision = captureExportRevision();
  const entryFile = revision.files.find(file => file.id === revision.entryId) || revision.files.find(isHtmlFile);
  if (!entryFile) return '';

  const dataUrlMap = await createVirtualFileDataUrlSnapshot(revision.files);
  return resolveVirtualPaths(entryFile.content || '', dataUrlMap, entryFile.name);
}

let jszipLoadingPromise = null;
function ensureJSZip() {
  if (typeof window.JSZip === 'function') {
    return Promise.resolve(window.JSZip);
  }
  if (jszipLoadingPromise) {
    return jszipLoadingPromise;
  }
  const loadAttempt = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('jszip.min.js', APP_ROOT_URL).href;
    script.onload = () => {
      if (typeof window.JSZip === 'function') {
        resolve(window.JSZip);
      } else {
        reject(new Error('JSZip not defined after script load'));
      }
    };
    script.onerror = () => {
      const cdnScript = document.createElement('script');
      cdnScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      cdnScript.onload = () => {
        if (typeof window.JSZip === 'function') {
          resolve(window.JSZip);
        } else {
          reject(new Error('JSZip not defined after CDN load'));
        }
      };
      cdnScript.onerror = () => reject(new Error('Failed to load JSZip from CDN'));
      document.head.appendChild(cdnScript);
    };
    document.head.appendChild(script);
  });
  jszipLoadingPromise = loadAttempt.catch(error => {
    // A transient local/CDN failure must not poison every later import.
    jszipLoadingPromise = null;
    throw error;
  });
  return jszipLoadingPromise;
}

async function exportToZip() {
  const revision = captureExportRevision();
  let JSZipCtor;
  try {
    JSZipCtor = await ensureJSZip();
  } catch (err) {
    showToast(t('toast_jszip_not_loaded'), 'error');
    return;
  }

  // Get project root folder name from virtual files
  const rootFolder = getProjectRootFolder().replace(/\/$/, '');
  const folderName = rootFolder.replace(/[\\/:*?"<>|]/g, '_') || t('default_folder_name');

  const zip = new JSZipCtor();

  revision.files.forEach(file => {
    if (file.isFolder) {
      zip.folder(file.name);
    } else {
      zip.file(file.name, getRevisionFileBlob(file));
    }
  });

  zip.generateAsync({ type: 'blob' }).then(function (content) {
    const fullName = `${folderName}.zip`;
    downloadBlob(content, fullName);
    showToast(t('toast_project_exported_zip', { name: fullName }));
    closeModal('modal-export');
  }).catch(function (err) {
    showToast(t('toast_zip_generate_error'), 'error');
  });
}

async function exportToFolder() {
  if (typeof window.showDirectoryPicker !== 'function') {
    showToast(t('toast_local_export_unsupported'), 'error');
    return;
  }

  try {
    const dirHandle = await window.showDirectoryPicker({
      mode: 'readwrite'
    });

    for (const file of files) {
      if (file.isFolder) {
        const pathParts = file.name.split('/').filter(Boolean);
        let currentDirHandle = dirHandle;
        for (const part of pathParts) {
          currentDirHandle = await currentDirHandle.getDirectoryHandle(part, { create: true });
        }
        continue;
      }

      const pathParts = file.name.split('/');
      let currentDirHandle = dirHandle;

      for (let i = 0; i < pathParts.length - 1; i++) {
        const part = pathParts[i];
        if (part && part !== '.' && part !== '..') {
          currentDirHandle = await currentDirHandle.getDirectoryHandle(part, { create: true });
        }
      }

      const fileName = pathParts[pathParts.length - 1];
      const fileHandle = await currentDirHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(getFileBlob(file));
      await writable.close();
    }

    showToast(t('toast_local_export_success'));
    closeModal('modal-export');
  } catch (err) {
    if (err.name === 'AbortError') {
      showToast(t('toast_export_cancelled'), 'info');
    } else {
      showToast(t('toast_folder_export_error', { message: err.message }), 'error');
    }
  }
}

async function importSingleHtmlFile(file, operationToken = null) {
  const token = operationToken ?? startImportOperation();
  try {
    const html = await readTextFile(file);
    if (token !== importGeneration || !editor) return false;

    if (!beginProjectReplacement(token)) return false;
    importCommitInProgress = true;
    try {
      setEditorValue(html);
    } finally {
      importCommitInProgress = false;
    }

    let name = file.name;
    if (name.toLowerCase().endsWith('.html')) {
      name = name.substring(0, name.length - 5);
    } else if (name.toLowerCase().endsWith('.htm')) {
      name = name.substring(0, name.length - 4);
    }
    if (filenameInput) {
      filenameInput.value = name;
      adjustFilenameWidth();
    }

    showToast(t('toast_html_imported', { name: file.name }));
    return true;
  } catch (err) {
    if (token === importGeneration) {
      void err;
      showToast(t('toast_html_read_error'), 'error');
    }
    return false;
  }
}

async function importFromZip(zipFile, operationToken = null) {
  const token = operationToken ?? startImportOperation();
  let JSZipCtor;
  try {
    JSZipCtor = await ensureJSZip();
  } catch (err) {
    showToast(t('toast_jszip_not_loaded'), 'error');
    return false;
  }

  try {
    const zip = await JSZipCtor.loadAsync(zipFile);
    const entries = [];
    zip.forEach((relativePath, zipEntry) => {
      if (isIgnorableImportedPath(zipEntry.name)) return;
      entries.push({ relativePath, zipEntry });
    });
    const newFiles = [];
    let fileCounter = 0;
    for (const { relativePath, zipEntry } of entries) {
      if (token !== importGeneration) return false;
      if (zipEntry.dir) {
        newFiles.push(createFolderRecord(relativePath.endsWith('/') ? relativePath : relativePath + '/', {
          id: createFileId('folder'),
          order: nextFileOrder + fileCounter++
        }));
        continue;
      }

      const fileId = createFileId('file');
      const order = nextFileOrder + fileCounter++;
      const content = isTextFilename(relativePath)
        ? decodeTextFileBytes(await zipEntry.async('uint8array'), relativePath)
        : await zipEntry.async('blob');
      newFiles.push(isTextFilename(relativePath)
        ? createTextFileRecord(relativePath, content, { id: fileId, order })
        : createBinaryFileRecord(relativePath, content, { id: fileId, order, mimeType: getMimeTypeForFilename(relativePath) }));
      if (fileCounter % 24 === 0) await yieldToMainThread();
    }

    if (newFiles.length === 0) {
      showToast(t('toast_zip_no_valid_files'), 'error');
      return false;
    }

    const zipName = zipFile.name.replace(/\.zip$/i, '');
    if (token !== importGeneration) return false;
    return loadProjectFiles(
      newFiles,
      t('toast_folder_imported', { count: newFiles.length }),
      zipName,
      { importToken: token }
    );
  } catch (err) {
    if (token === importGeneration) {
      void err;
      showToast(t('toast_zip_import_error'), 'error');
    }
    return false;
  }
}

function isIgnorableImportedPath(pathValue) {
  const normalized = String(pathValue || '').replace(/\\/g, '/');
  const basename = normalized.split('/').filter(Boolean).pop() || '';
  return normalized.startsWith('__MACOSX/') ||
    basename === '.DS_Store' ||
    basename === 'Thumbs.db' ||
    basename === 'desktop.ini' ||
    normalized.includes('/__MACOSX/');
}

async function createRecordsFromDataTransfer(dataTransfer, targetPath = '') {
  const records = [];
  const items = Array.from(dataTransfer.items || []);

  if (items.length > 0 && items.some(item => typeof item.webkitGetAsEntry === 'function')) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (!entry || isIgnorableImportedPath(entry.name)) continue;

      if (entry.isDirectory) {
        const entries = await readDirectoryEntryEntries(entry);
        records.push(createFolderRecord(joinProjectPath(targetPath, entry.name, { folder: true })));
        for (const nestedEntry of entries) {
          const nestedPath = joinProjectPath(joinProjectPath(targetPath, entry.name, { folder: true }), nestedEntry.relativePath, { folder: nestedEntry.isDirectory });
          if (isIgnorableImportedPath(nestedPath)) continue;
          if (nestedEntry.isDirectory) {
            records.push(createFolderRecord(nestedPath));
          } else {
            const browserFile = await new Promise((resolve, reject) => nestedEntry.entry.file(resolve, reject));
            const record = await createRecordFromBrowserFile(browserFile, getParentPath(nestedPath));
            record.name = normalizeProjectPath(nestedPath);
            records.push(record);
          }
        }
      } else if (entry.isFile) {
        const browserFile = item.getAsFile?.();
        if (browserFile && !isIgnorableImportedPath(browserFile.name)) {
          records.push(await createRecordFromBrowserFile(browserFile, targetPath));
        }
      }
    }
    return records;
  }

  for (const file of Array.from(dataTransfer.files || [])) {
    if (isIgnorableImportedPath(file.name)) continue;
    records.push(await createRecordFromBrowserFile(file, targetPath));
  }
  return records;
}

function isInternalExplorerDrag(event) {
  return internalDragState || Array.from(event.dataTransfer?.types || []).includes('application/x-vfs-item');
}

function isInternalTabDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes('application/x-editor-tab');
}

function isInternalAppDrag(event) {
  return isInternalExplorerDrag(event) || isInternalTabDrag(event);
}

function dataTransferHasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

let externalFileDragDepth = 0;
let explorerOpenedTemporarilyForDrag = false;

function getDropIntent(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []).filter(item => item.kind === 'file');
  const filesToDrop = Array.from(dataTransfer?.files || []);
  const count = Math.max(items.length, filesToDrop.length);
  if (count > 1) return 'multiple';

  const item = items[0];
  const entry = item?.webkitGetAsEntry?.();
  if (entry?.isDirectory) return 'project';

  const file = filesToDrop[0] || item?.getAsFile?.();
  const ext = getFileExtension(file?.name || entry?.name || '');
  if (ext === 'zip') return 'project';
  if (ext === 'html' || ext === 'htm') return 'html';
  return 'files';
}

function showDragDropLoading(message = currentLocale === 'es' ? 'Procesando archivos...' : 'Processing files...') {
  const overlay = document.getElementById('drag-drop-overlay');
  const title = document.getElementById('drag-drop-title');
  const description = document.getElementById('drag-drop-description');
  if (!overlay || !title || !description) return;

  title.textContent = message;
  description.textContent = currentLocale === 'es' ? 'Por favor, espera un momento mientras procesamos los archivos...' : 'Please wait a moment while we process the files...';
  
  overlay.classList.add('is-processing');
  
  const icon = overlay.querySelector('.drag-drop-icon');
  if (icon) {
    icon.setAttribute('data-lucide', 'loader-2');
    icon.classList.add('animate-spin');
    if (window.lucide?.createIcons) {
      window.lucide.createIcons();
    }
  }
}

function updateDragDropOverlay(dataTransfer, { treeTarget = false } = {}) {
  const overlay = document.getElementById('drag-drop-overlay');
  const title = document.getElementById('drag-drop-title');
  const description = document.getElementById('drag-drop-description');
  const fileExplorer = document.getElementById('file-explorer');
  if (!overlay || !title || !description) return;

  // Reset overlay processing classes and icon
  overlay.classList.remove('is-processing');
  const icon = overlay.querySelector('.drag-drop-icon');
  if (icon) {
    icon.setAttribute('data-lucide', 'file-up');
    icon.classList.remove('animate-spin');
    if (window.lucide?.createIcons) {
      window.lucide.createIcons();
    }
  }

  if (treeTarget) {
    title.textContent = t('drag_title_add');
    description.textContent = t('drag_desc_add');
    overlay.classList.add('tree-target');
    overlay.classList.remove('project-target');
    fileExplorer?.classList.add('external-drop-target');
  } else {
    const intent = getDropIntent(dataTransfer);
    title.textContent = intent === 'project'
      ? t('drag_title_project')
      : (intent === 'html' ? t('drag_title_html') : t('drag_title_import'));
    description.textContent = intent === 'files'
      ? t('drag_desc_files')
      : t('drag_desc_main');
    overlay.classList.remove('tree-target');
    overlay.classList.toggle('project-target', intent === 'project');
    fileExplorer?.classList.remove('external-drop-target');
  }

  overlay.style.display = 'flex';
}

function beginExternalFileDrag(dataTransfer, target) {
  document.body.classList.add('external-file-dragging');
  if (editorMode === 'split' && isExplorerCollapsed && !explorerOpenedTemporarilyForDrag) {
    explorerOpenedTemporarilyForDrag = true;
    toggleFileExplorer(false);
  }
  updateDragDropOverlay(dataTransfer, { treeTarget: Boolean(target?.closest?.('#file-explorer')) });
}

function finishExternalFileDrag({ keepExplorerOpen = false } = {}) {
  const overlay = document.getElementById('drag-drop-overlay');
  const fileExplorer = document.getElementById('file-explorer');
  externalFileDragDepth = 0;
  document.body.classList.remove('external-file-dragging');
  overlay?.classList.remove('tree-target');
  overlay?.classList.remove('project-target');
  if (overlay) overlay.style.display = 'none';
  fileExplorer?.classList.remove('external-drop-target');
  document.getElementById('file-list')?.classList.remove('drop-inside');
  clearExplorerDropState();

  if (explorerOpenedTemporarilyForDrag && !keepExplorerOpen && !isExplorerCollapsed) {
    toggleFileExplorer(false);
  } else if (keepExplorerOpen && editorMode === 'split' && isExplorerCollapsed) {
    toggleFileExplorer(false);
  }
  explorerOpenedTemporarilyForDrag = false;
}

async function addDroppedFilesToProject(dataTransfer, targetPath = '', operationToken = null) {
  const token = operationToken ?? startImportOperation();
  const identityAtStart = projectIdentity;
  try {
    const records = await createRecordsFromDataTransfer(dataTransfer, targetPath);
    if (token !== importGeneration || identityAtStart !== projectIdentity) return 0;
    if (records.length === 0) {
      showToast(t('toast_no_valid_import'), 'error');
      return 0;
    }
    // createRecordsFromDataTransfer already materializes the requested target
    // path (including nested directory entries). Do not prepend it a second
    // time when committing the batch.
    addFilesToProject(records, '');
    return records.length;
  } catch (error) {
    if (token === importGeneration && identityAtStart === projectIdentity) {
      console.error('Error añadiendo archivos soltados', error);
      showToast(t('toast_no_valid_import'), 'error');
    }
    return 0;
  }
}

function snapshotDataTransfer(dataTransfer) {
  const rawItems = Array.from(dataTransfer?.items || []);
  return {
    items: rawItems.map(item => {
      const entry = item.webkitGetAsEntry?.() || null;
      const file = item.getAsFile?.() || null;
      return {
        kind: item.kind,
        webkitGetAsEntry: () => entry,
        getAsFile: () => file
      };
    }),
    files: Array.from(dataTransfer?.files || [])
  };
}

async function importDroppedFilesGlobally(dataTransfer) {
  const token = startImportOperation();
  const items = Array.from(dataTransfer.items || []).filter(item => item.kind === 'file');
  const filesToDrop = Array.from(dataTransfer.files || []);
  const itemCount = Math.max(items.length, filesToDrop.length);

  if (itemCount > 1) {
    const records = await createRecordsFromDataTransfer(dataTransfer);
    if (records.length === 0) {
      showToast(t('toast_no_valid_import'), 'error');
      return { imported: false, project: false };
    }
    if (token !== importGeneration) return { imported: false, project: false };
    const imported = loadProjectFiles(
      records,
      t('toast_folder_imported', { count: records.length }),
      t('imported_project_name'),
      { importToken: token }
    );
    return { imported: imported, project: Boolean(imported) };
  }

  const item = items[0];
  const entry = item?.webkitGetAsEntry?.();
  if (entry?.isDirectory) {
    const imported = await importFolderEntry(entry, token);
    return { imported, project: imported };
  }

  const file = filesToDrop[0] || item?.getAsFile?.();
  if (!file) return { imported: false, project: false };
  const ext = getFileExtension(file.name);
  if (ext === 'zip') {
    const imported = await importFromZip(file, token);
    return { imported, project: imported };
  }
  if (ext === 'html' || ext === 'htm') {
    const imported = await importSingleHtmlFile(file, token);
    return { imported, project: false };
  }

  const added = await addDroppedFilesToProject(dataTransfer, '', token);
  if (added > 0) {
    const msgKey = added === 1 ? 'toast_file_added_to_project' : 'toast_files_added_to_project';
    showToast(`${added} ${t(msgKey)}`);
  }
  return { imported: added > 0, project: added > 0 };
}

// Global drop replaces/opens; file-tree handlers add through addDroppedFilesToProject().
function initDragAndDrop() {
  const container = document.querySelector('.app-container');
  const overlay = document.getElementById('drag-drop-overlay');
  if (!container || !overlay) return;

  window.addEventListener('dragenter', (event) => {
    if (!dataTransferHasFiles(event) || isInternalAppDrag(event)) return;
    event.preventDefault();
    externalFileDragDepth++;
    beginExternalFileDrag(event.dataTransfer, event.target);
  });

  window.addEventListener('dragover', (event) => {
    if (!dataTransferHasFiles(event) || isInternalAppDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    beginExternalFileDrag(event.dataTransfer, event.target);
  });

  window.addEventListener('dragleave', (event) => {
    if (!dataTransferHasFiles(event) || isInternalAppDrag(event)) return;
    event.preventDefault();
    if (!event.relatedTarget) {
      finishExternalFileDrag();
      return;
    }
    externalFileDragDepth = Math.max(0, externalFileDragDepth - 1);
    if (externalFileDragDepth === 0) finishExternalFileDrag();
  });

  window.addEventListener('drop', async (event) => {
    if (!dataTransferHasFiles(event)) return;
    event.preventDefault();
    if (isInternalAppDrag(event) || event.target.closest?.('#file-explorer')) return;

    const payload = snapshotDataTransfer(event.dataTransfer);
    showDragDropLoading(currentLocale === 'es' ? 'Importando archivos...' : 'Importing files...');
    try {
      const result = await importDroppedFilesGlobally(payload);
      finishExternalFileDrag({ keepExplorerOpen: result.project });
    } catch (error) {
      console.error('Error importando archivos soltados', error);
      showToast(t('toast_no_valid_import'), 'error');
      finishExternalFileDrag();
    }
  });

  window.addEventListener('blur', () => {
    if (externalFileDragDepth > 0) finishExternalFileDrag();
  });
  document.addEventListener('dragend', () => finishExternalFileDrag());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && externalFileDragDepth > 0) finishExternalFileDrag();
  });
}

// Recursively traverse directory entries
function readDirectoryEntryEntries(dirEntry, path = '') {
  return new Promise((resolve, reject) => {
    const dirReader = dirEntry.createReader();
    const fileEntries = [];

    const readEntries = () => {
      dirReader.readEntries(async (entries) => {
        if (entries.length === 0) {
          resolve(fileEntries);
        } else {
          for (const entry of entries) {
            if (isIgnorableImportedPath(entry.name)) continue;

            const relativePath = path + entry.name;
            if (entry.isFile) {
              entry.relativePath = relativePath;
              fileEntries.push({ entry, relativePath, isDirectory: false });
            } else if (entry.isDirectory) {
              fileEntries.push({ entry, relativePath: `${relativePath}/`, isDirectory: true });
              try {
                const subEntries = await readDirectoryEntryEntries(entry, path + entry.name + '/');
                fileEntries.push(...subEntries);
              } catch (e) {
                void e;
              }
            }
          }
          readEntries();
        }
      }, reject);
    };
    readEntries();
  });
}

async function importFolderEntry(directoryEntry, operationToken = null) {
  const token = operationToken ?? startImportOperation();
  try {
    const fileEntries = await readDirectoryEntryEntries(directoryEntry);
    const newFiles = [];

    for (let i = 0; i < fileEntries.length; i++) {
      const fileEntry = fileEntries[i];
      if (fileEntry.isDirectory) {
        newFiles.push(createFolderRecord(fileEntry.relativePath));
        continue;
      }

      const browserFile = await new Promise((resolve, reject) => {
        fileEntry.entry.file(resolve, reject);
      });
      const record = await createRecordFromBrowserFile(browserFile, getParentPath(fileEntry.relativePath));
      record.name = normalizeProjectPath(fileEntry.relativePath);
      newFiles.push(record);
    }

    if (newFiles.length === 0) {
      showToast(t('toast_no_valid_import'), 'error');
      return false;
    }

    const folderName = directoryEntry.name;
    if (token !== importGeneration) return false;
    return loadProjectFiles(
      newFiles,
      t('toast_folder_imported', { count: newFiles.length }),
      folderName,
      { importToken: token }
    );
  } catch (err) {
    if (token === importGeneration) {
      void err;
      showToast(t('toast_folder_import_error'), 'error');
    }
    return false;
  }
}

function initImportExportOptions() {
  initModalCloseEvents();

  // --- EXPORT MODAL BINDINGS ---
  const btnExportFolderOpt = document.getElementById('btn-export-folder-opt');
  if (btnExportFolderOpt) {
    btnExportFolderOpt.addEventListener('click', () => {
      exportToFolder();
    });
  }

  const btnExportZipOpt = document.getElementById('btn-export-zip-opt');
  if (btnExportZipOpt) {
    btnExportZipOpt.addEventListener('click', () => {
      exportToZip();
    });
  }

  const btnExportUnifiedOpt = document.getElementById('btn-export-unified-opt');
  if (btnExportUnifiedOpt) {
    btnExportUnifiedOpt.addEventListener('click', async () => {
      if (!editor) return;
      try {
        const code = await compileToUnifiedHTML();
        const blob = new Blob([code], { type: 'text/html;charset=utf-8' });
        const suffix = currentLocale === 'es' ? '_unificado.html' : '_unified.html';
        const fullName = `${getExportBaseName()}${suffix}`;
        downloadBlob(blob, fullName);
        showToast(t('toast_unified_html_exported', { name: fullName }));
        closeModal('modal-export');
      } catch (err) {
        showToast(t('toast_unified_export_error'), 'error');
      }
    });
  }
}


// Theme Toggle (Dark / Light)
document.getElementById('btn-theme').addEventListener('click', () => {
  const htmlEl = document.documentElement;
  const currentTheme = htmlEl.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

  htmlEl.setAttribute('data-theme', newTheme);
  writeStoredValue('theme', newTheme);

  // Update UI Text
  const themeLabel = document.querySelector('#btn-theme span');

  if (newTheme === 'dark') {
    themeLabel.textContent = t('sidebar_mode_dark');
    if (editor && monacoLoaded) {
      monaco.editor.setTheme('app-dark-theme');
    }
  } else {
    themeLabel.textContent = t('sidebar_mode_light');
    if (editor && monacoLoaded) {
      monaco.editor.setTheme('app-light-theme');
    }
  }

  if (previewIframe?.classList.contains('is-empty')) {
    lastPreviewCode = '';
    schedulePreviewUpdate({ force: true });
  }
});
