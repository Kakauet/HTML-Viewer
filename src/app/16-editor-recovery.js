// Optional local recovery for editable work. The preview service worker has
// its own cache, but that cache is not an editable-project backup. IndexedDB
// is deliberately best-effort: a denied or unavailable store never blocks
// the editor, and the in-memory state remains authoritative for the session.
const EDITOR_RECOVERY_DB_NAME = 'html-viewer-editor-recovery';
const EDITOR_RECOVERY_DB_VERSION = 1;
const EDITOR_RECOVERY_KEY = 'latest';

let editorRecoveryDbPromise = null;
let editorRecoverySaveTimer = 0;
let editorRecoveryWriteSerial = 0;
let editorRecoveryPendingSnapshot = null;
let editorRecoveryApplied = false;
let editorRecoveryCancelled = false;
let editorRecoveryUserActivity = false;
let editorRecoveryDisabled = false;

function openEditorRecoveryDb() {
  if (editorRecoveryDbPromise) return editorRecoveryDbPromise;
  if (!window.indexedDB) return Promise.reject(new Error('IndexedDB no disponible'));

  editorRecoveryDbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(EDITOR_RECOVERY_DB_NAME, EDITOR_RECOVERY_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('snapshots')) {
        database.createObjectStore('snapshots', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir la recuperación local'));
    request.onblocked = () => reject(new Error('La recuperación local está bloqueada'));
  }).catch(error => {
    editorRecoveryDbPromise = null;
    throw error;
  });

  return editorRecoveryDbPromise;
}

function captureEditorRecoverySnapshot() {
  const snapshotFiles = files.map(file => {
    const binary = Boolean(file.isBinary);
    return {
      id: String(file.id || createFileId('recovered')),
      name: file.name,
      content: binary ? '' : getFileText(file),
      blob: binary ? (file.blob || null) : null,
      dataUrl: file.dataUrl || '',
      type: file.type || '',
      mimeType: file.mimeType || '',
      isFolder: Boolean(file.isFolder),
      isBinary: binary,
      size: Number(file.size) || 0,
      order: Number(file.order) || 0
    };
  });

  return {
    id: EDITOR_RECOVERY_KEY,
    savedAt: Date.now(),
    userInitiated: true,
    mode: editorMode,
    cameFromSplitMode: Boolean(cameFromSplitMode),
    files: snapshotFiles,
    activeFileId: activeFileId || '',
    openFileIds: Array.from(openFileIds || []),
    selectedEntryFileId: selectedEntryFileId || '',
    unifiedContent: editorMode === 'unified'
      ? getCurrentEditorDocumentText()
      : (unifiedModel?.getValue?.() || ''),
    visibleFilename: filenameInput?.value || '',
    projectPath: previewLifecycle.projectPath || '',
    projectSearch: previewLifecycle.projectSearch || '',
    projectHash: previewLifecycle.projectHash || ''
  };
}

async function writeEditorRecoverySnapshot() {
  if (editorRecoveryDisabled) return;
  const serial = ++editorRecoveryWriteSerial;
  let snapshot;
  try {
    snapshot = captureEditorRecoverySnapshot();
    const database = await openEditorRecoveryDb();
    if (serial !== editorRecoveryWriteSerial) return;

    await new Promise((resolve, reject) => {
      const transaction = database.transaction('snapshots', 'readwrite');
      transaction.objectStore('snapshots').put(snapshot);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la recuperación local'));
      transaction.onabort = () => reject(transaction.error || new Error('No se pudo guardar la recuperación local'));
    });
  } catch (error) {
    // Storage is optional. Keep the failure quiet in the UI, but leave a
    // diagnostic for development without preventing the current edit.
    if (serial === editorRecoveryWriteSerial) {
      editorRecoveryDisabled = true;
      console.warn('Recuperación local no disponible', error);
    }
  }
}

function scheduleRecoverySave() {
  editorRecoveryUserActivity = true;
  editorRecoveryCancelled = true;
  editorRecoveryPendingSnapshot = null;
  clearTimeout(editorRecoverySaveTimer);
  editorRecoverySaveTimer = setTimeout(() => {
    editorRecoverySaveTimer = 0;
    void writeEditorRecoverySnapshot();
  }, 350);
}

function cancelPendingRecovery() {
  editorRecoveryCancelled = true;
  editorRecoveryPendingSnapshot = null;
  clearTimeout(editorRecoverySaveTimer);
  editorRecoverySaveTimer = 0;
}

window.scheduleRecoverySave = scheduleRecoverySave;
window.cancelPendingRecovery = cancelPendingRecovery;

function normalizeRecoveredFile(record) {
  if (!record || !record.name) return null;
  const name = normalizeProjectPath(record.name, { folder: Boolean(record.isFolder) });
  if (!name) return null;
  if (record.isFolder) {
    return createFolderRecord(name, { id: record.id, order: record.order });
  }

  const binary = Boolean(record.isBinary);
  const restored = {
    id: record.id || createFileId(binary ? 'asset' : 'file'),
    name,
    content: binary ? '' : String(record.content || ''),
    blob: binary
      ? (record.blob instanceof Blob ? record.blob : new Blob([], { type: record.mimeType || getMimeTypeForFilename(name) }))
      : undefined,
    dataUrl: String(record.dataUrl || ''),
    type: record.type || getFileExtension(name) || 'plaintext',
    mimeType: record.mimeType || getMimeTypeForFilename(name),
    isBinary: binary,
    size: Number(record.size) || 0,
    order: Number(record.order) || nextFileOrder++
  };
  if (!restored.size) restored.size = binary ? restored.blob.size : new Blob([restored.content]).size;
  return restored;
}

function recoverySnapshotLooksUseful(snapshot) {
  return Boolean(
    snapshot &&
    Array.isArray(snapshot.files) &&
    snapshot.userInitiated !== false &&
    snapshot.files.some(file => file && !file.isFolder) &&
    // An emptied editor is nothing to recover; announcing it would be noise.
    (
      String(snapshot.unifiedContent || '').trim() ||
      snapshot.files.some(file => file && !file.isFolder && (file.isBinary || String(file.content || '').trim()))
    )
  );
}

async function restoreEditorRecoverySnapshot(snapshot) {
  if (editorRecoveryApplied || editorRecoveryCancelled || editorRecoveryUserActivity) return false;
  if (!editor || !recoverySnapshotLooksUseful(snapshot)) return false;

  editorRecoveryApplied = true;
  const wasRestoring = isRestoringHistory;
  isRestoringHistory = true;
  try {
    invalidatePreviewLifecycle('recovery');
    previewLifecycle.sessionGeneration += 1;
    projectPreviewKnownPaths = new Set();
    projectPreviewSiteRoot = '';
    projectPreviewNeedsFullSync = true;
    resetProjectPreviewLocation();

    const desiredMode = snapshot.mode === 'split' ? 'split' : 'unified';
    if (editorMode !== desiredMode) {
      await switchEditorMode(desiredMode, false, { render: false });
    }

    disposeAllFileModels();
    const recoveredFiles = snapshot.files.map(normalizeRecoveredFile).filter(Boolean);
    if (recoveredFiles.length === 0) return false;

    files = recoveredFiles;
    cameFromSplitMode = Boolean(snapshot.cameFromSplitMode);
    openFileIds = snapshot.openFileIds.filter(id => files.some(file => file.id === id && !file.isFolder));
    selectedEntryFileId = files.some(file => file.id === snapshot.selectedEntryFileId)
      ? snapshot.selectedEntryFileId
      : '';
    const recoveredActiveFile = files.find(file => file.id === snapshot.activeFileId);
    activeFileId = recoveredActiveFile && !recoveredActiveFile.isFolder
      ? recoveredActiveFile.id
      : '';
    normalizeProjectFiles();
    syncSelectedEntryFile();

    if (editorMode === 'unified') {
      const entryFile = getEntryFile();
      const content = typeof snapshot.unifiedContent === 'string'
        ? snapshot.unifiedContent
        : getFileText(entryFile);
      if (entryFile) {
        entryFile.content = content;
        entryFile.size = new Blob([content]).size;
      }
      if (monacoLoaded && unifiedModel) {
        unifiedModel.setValue(content);
        editor.setModel(unifiedModel);
        unifiedLastKnownContent = content;
      } else if (fallbackTextarea) {
        fallbackTextarea.value = content;
        fallbackLastKnownValue = content;
      }
    } else {
      syncModelsForFiles();
      // Recovery should reopen an editable surface when the last selected
      // item was a binary asset. Otherwise the asset viewer hides both Monaco
      // and the fallback textarea during the first interaction after reload.
      const activeFile = files.find(file => file.id === activeFileId && !file.isFolder && isEditableFile(file))
        || getEntryFile()
        || files.find(file => !file.isFolder && isEditableFile(file))
        || files.find(file => !file.isFolder);
      if (activeFile) {
        activeFileId = activeFile.id;
        if (!openFileIds.includes(activeFile.id)) openFileIds.push(activeFile.id);
        openFile(activeFile.id, { autoCollapse: false });
      }
    }

    if (filenameInput && snapshot.visibleFilename) {
      filenameInput.value = snapshot.visibleFilename;
      adjustFilenameWidth?.();
    }
    if (editorMode === 'split') {
      setProjectPreviewLocation(snapshot.projectPath || getEntryFile()?.name || '', snapshot.projectPath || getEntryFile()?.name || '');
    }
    renderFileExplorer();
    renderActiveFileSummary();
    updateEntryHtmlSelector();
    updateFileNameExtension();
    updateEditorPlaceholder();
    updatePreview({
      force: true,
      full: editorMode === 'split',
      forceNavigation: true,
      reason: 'recovery',
      targetPath: editorMode === 'split' ? (snapshot.projectPath || getEntryFile()?.name || '') : ''
    });
    showToast(currentLocale === 'es' ? 'Se recuperó la última edición local.' : 'The latest local edit was recovered.', 'info');
    return true;
  } catch (error) {
    editorRecoveryApplied = false;
    console.warn('No se pudo recuperar la edición local', error);
    return false;
  } finally {
    isRestoringHistory = wasRestoring;
  }
}

async function loadEditorRecoverySnapshot() {
  if (editorRecoveryDisabled) return;
  try {
    const database = await openEditorRecoveryDb();
    const snapshot = await new Promise((resolve, reject) => {
      const request = database.transaction('snapshots', 'readonly')
        .objectStore('snapshots').get(EDITOR_RECOVERY_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    if (!snapshot || editorRecoveryCancelled || editorRecoveryUserActivity) return;
    editorRecoveryPendingSnapshot = snapshot;
    await restoreEditorRecoverySnapshot(snapshot);
  } catch {
    editorRecoveryDisabled = true;
    // Optional feature: private browsing and disabled storage must not block
    // the editor or turn a successful import into an error.
  }
}

void loadEditorRecoverySnapshot();
