// File chooser and project-tree interactions.
const collapsedFolders = new Set();
const LARGE_PROJECT_COLLAPSE_THRESHOLD = 300;
const EXPLORER_LONG_PRESS_MS = 430;
let suppressExplorerClickUntil = 0;

function collapseLargeProjectFolders(entryFile = null) {
  if (files.length < LARGE_PROJECT_COLLAPSE_THRESHOLD) return;

  collapsedFolders.clear();
  const openFolders = new Set();
  if (entryFile) {
    const parts = getParentPath(entryFile.name).split('/').filter(Boolean);
    let currentPath = '';
    for (const part of parts) {
      currentPath += `${part}/`;
      openFolders.add(currentPath);
    }
  }

  files.forEach(file => {
    if (file.isFolder && !openFolders.has(file.name)) {
      collapsedFolders.add(file.name);
    }
  });
}

// Helper to build a hierarchical tree of files
function buildFileTree(filesList) {
  const root = { name: '', path: '', isFolder: true, children: {} };

  filesList.forEach(file => {
    const parts = file.name.split('/').filter(Boolean);
    let current = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      const isLast = (i === parts.length - 1);
      currentPath += part + (isLast && file.isFolder ? '/' : (isLast ? '' : '/'));

      if (isLast) {
        if (file.isFolder) {
          if (!current.children[part]) {
            current.children[part] = {
              id: file.id,
              name: part,
              path: currentPath,
              isFolder: true,
              children: {},
              order: file.order || 0
            };
          } else {
            current.children[part].id = file.id;
            current.children[part].order = file.order || current.children[part].order || 0;
          }
        } else {
          current.children[part] = {
            id: file.id,
            name: part,
            path: file.name,
            isFolder: false,
            fileRef: file,
            order: file.order || 0
          };
        }
      } else {
        if (!current.children[part]) {
          current.children[part] = {
            id: 'folder-' + Math.random().toString(36).substr(2, 9),
            name: part,
            path: currentPath,
            isFolder: true,
            children: {},
            order: 0
          };
        }
        current = current.children[part];
      }
    }
  });

  return root;
}

// Find a folder node in the built tree recursively
function findFolderNodeByPath(node, path) {
  if (node.path === path) return node;
  for (const key in node.children) {
    const child = node.children[key];
    if (child.isFolder) {
      const found = findFolderNodeByPath(child, path);
      if (found) return found;
    }
  }
  return null;
}

function getFileByPath(path) {
  const cleanPath = normalizeProjectPath(path, { folder: path.endsWith('/') });
  return files.find(file => file.name === cleanPath);
}

function rewriteReferenceValue(refPath, hostFilename, oldPath, newPath, newHostFilename = hostFilename) {
  const { suffix } = splitPathSuffix(refPath);
  const cleanOldPath = normalizeProjectPath(oldPath);
  const matchedPath = getReferencePathCandidates(hostFilename, refPath)
    .find(candidatePath => candidatePath === cleanOldPath);
  if (!matchedPath) return refPath;
  return `${makeRelativePath(newHostFilename, newPath)}${suffix}`;
}

function rewriteReferencesInContent(content, hostFilename, oldPath, newPath, newHostFilename = hostFilename) {
  const transform = refPath => rewriteReferenceValue(refPath, hostFilename, oldPath, newPath, newHostFilename);
  const extension = getFileExtension(hostFilename);
  const result = extension === 'css'
    ? rewriteCssReferences(content, transform)
    : ((extension === 'html' || extension === 'htm' || !extension)
      ? rewriteHtmlReferenceAttributes(content, transform)
      : content);
  return { content: result, changed: result !== content };
}

function rewriteReferencesForHostMove(content, oldHostFilename, newHostFilename, pathChanges) {
  const knownPaths = new Set([
    ...files.filter(file => !file.isFolder).map(file => normalizeProjectPath(file.name)),
    ...pathChanges.flatMap(change => [normalizeProjectPath(change.oldPath), normalizeProjectPath(change.newPath)])
  ]);
  const transform = refPath => {
    const raw = String(refPath || '').trim();
    if (!raw || raw.startsWith('/') || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw)) return refPath;
    const { path, suffix } = splitPathSuffix(raw);
    const candidate = getReferencePathCandidates(oldHostFilename, path)
      .find(item => knownPaths.has(normalizeProjectPath(item)));
    if (!candidate) return refPath;
    return `${makeRelativePath(newHostFilename, candidate)}${suffix}`;
  };
  const extension = getFileExtension(oldHostFilename);
  if (extension === 'css') return rewriteCssReferences(content, transform);
  if (extension === 'html' || extension === 'htm' || !extension) {
    return rewriteHtmlReferenceAttributes(content, transform);
  }
  return content;
}

function applyPathReferenceChanges(pathChanges) {
  let updates = 0;
  const wasRestoring = isRestoringHistory;
  isRestoringHistory = true;
  try {
    const oldHostByNewPath = new Map(pathChanges.map(change => [change.newPath, change.oldPath]));
    files.forEach(file => {
      if (!isEditableFile(file)) return;
      const originalContent = getFileText(file);
      const oldHostFilename = oldHostByNewPath.get(file.name) || file.name;
      const newHostFilename = file.name;
      let content = originalContent;
      let changed = false;

      pathChanges.forEach(({ oldPath, newPath }) => {
        const result = rewriteReferencesInContent(content, oldHostFilename, oldPath, newPath, newHostFilename);
        content = result.content;
        changed = changed || result.changed;
      });
      if (oldHostFilename !== newHostFilename) {
        const movedResult = rewriteReferencesForHostMove(content, oldHostFilename, newHostFilename, pathChanges);
        changed = changed || movedResult !== content;
        content = movedResult;
      }

      if (changed) {
        file.content = content;
        file.size = new Blob([content]).size;
        if (monacoLoaded && fileModels[file.id]) {
          fileModels[file.id].setValue(content);
        } else if (!monacoLoaded && file.id === activeFileId) {
          fallbackTextarea.value = content;
        }
        updates++;
      }
    });
  } finally {
    isRestoringHistory = wasRestoring;
  }
  return updates;
}

function getImmediateRecords(parentPath = '') {
  const cleanParent = normalizeProjectPath(parentPath, { folder: true });
  return files
    .filter(file => getParentPath(file.name) === cleanParent)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || getBaseName(a.name).localeCompare(getBaseName(b.name)));
}

function assignOrderForParent(parentPath, orderedNames) {
  orderedNames.forEach((name, index) => {
    const file = files.find(item => item.name === name);
    if (file) file.order = index + 1;
  });
}

function moveVfsItemToFolder(source, targetFolderPath = '') {
  let targetFolder = targetFolderPath;
  if (!targetFolder) {
    targetFolder = getProjectRootFolder();
  }
  targetFolder = normalizeProjectPath(targetFolder, { folder: true });

  const rootFolder = getProjectRootFolder();
  if (!targetFolder.startsWith(rootFolder)) {
    showToast(t('toast_move_outside_root_error'), 'error');
    return false;
  }

  let pathChanges = [];

  if (source.kind === 'file') {
    const file = files.find(item => item.id === source.id);
    if (!file || file.isFolder) return false;
    const oldPath = file.name;
    const newPath = joinProjectPath(targetFolder, getBaseName(file.name));
    if (oldPath === newPath) return true;
    if (files.some(item => item.id !== file.id && item.name.toLowerCase() === newPath.toLowerCase())) {
      showToast(t('toast_file_exists_in_folder'), 'error');
      return false;
    }
    saveHistoryState();

    file.name = newPath;
    file.type = getFileExtension(newPath) || file.type;
    file.mimeType = getMimeTypeForFilename(newPath);
    ensureParentFoldersForPath(newPath);
    pathChanges.push({ oldPath, newPath });

    if (monacoLoaded && fileModels[file.id]) {
      monaco.editor.setModelLanguage(fileModels[file.id], getLanguageFromFilename(newPath));
    }
  } else if (source.kind === 'folder') {
    const oldPath = normalizeProjectPath(source.path, { folder: true });
    if (!oldPath) return false;
    if (targetFolder.startsWith(oldPath)) {
      showToast(t('toast_move_inside_self_error'), 'error');
      return false;
    }

    const newPath = joinProjectPath(targetFolder, getBaseName(oldPath), { folder: true });
    if (oldPath === newPath) return true;
    if (files.some(item => item.id !== source.id && item.name.toLowerCase() === newPath.toLowerCase())) {
      showToast(t('toast_folder_exists_in_location'), 'error');
      return false;
    }
    saveHistoryState();

    const movingFiles = files.filter(file => file.name.startsWith(oldPath));
    movingFiles.forEach(file => {
      const previousPath = file.name;
      file.name = newPath + file.name.substring(oldPath.length);
      if (!file.isFolder) {
        pathChanges.push({ oldPath: previousPath, newPath: file.name });
      }
    });

    if (collapsedFolders.has(oldPath)) {
      collapsedFolders.delete(oldPath);
      collapsedFolders.add(newPath);
    }
  }

  normalizeProjectFiles();
  cleanupVirtualBlobUrlCache();
  const updatedRefs = applyPathReferenceChanges(pathChanges);
  renderFileExplorer();
  renderActiveFileSummary();
  updateFileNameExtension();
  updateEditorPlaceholder();
  updatePreview();
  window.scheduleRecoverySave?.();
  if (updatedRefs > 0) {
    showToast(t('toast_files_updated_paths', { count: updatedRefs }), 'info');
  }
  return true;
}

function reorderVfsItemAround(source, targetPath, position) {
  const target = getFileByPath(targetPath);
  if (!target) return false;
  const targetParent = getParentPath(target.name);
  const sourceParent = getParentPath(normalizeProjectPath(source.path || '', { folder: source.kind === 'folder' }));
  // A move records its own history step; a reorder inside the same folder
  // only changes ordering, so record it here.
  if (sourceParent === normalizeProjectPath(targetParent, { folder: true })) saveHistoryState();
  if (!moveVfsItemToFolder(source, targetParent)) return false;

  const sourceRecord = source.kind === 'file'
    ? files.find(file => file.id === source.id)
    : files.find(file => file.id === source.id) || files.find(file => file.isFolder && getBaseName(file.name) === getBaseName(source.path) && getParentPath(file.name) === targetParent);
  if (!sourceRecord) return false;

  const siblingNames = getImmediateRecords(targetParent).map(file => file.name).filter(name => name !== sourceRecord.name);
  const targetIndex = siblingNames.indexOf(target.name);
  const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
  siblingNames.splice(Math.max(0, insertIndex), 0, sourceRecord.name);
  assignOrderForParent(targetParent, siblingNames);
  renderFileExplorer();
  return true;
}

function clearExplorerDropState() {
  if (activeExplorerDropElement) {
    activeExplorerDropElement.classList.remove('drop-before', 'drop-after', 'drop-inside');
    activeExplorerDropElement = null;
  }
  document.querySelector('.dragging')?.classList.remove('dragging');
}

function setExplorerDropState(element, className) {
  if (activeExplorerDropElement && activeExplorerDropElement !== element) {
    activeExplorerDropElement.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }
  activeExplorerDropElement = element;
  element.classList.remove('drop-before', 'drop-after', 'drop-inside');
  element.classList.add(className);
}

function getDropPosition(event, element, allowInside = false) {
  const rect = element.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / rect.height;
  if (allowInside && ratio >= 0.25 && ratio <= 0.75) return 'inside';
  return ratio < 0.5 ? 'before' : 'after';
}

function getDragSourceFromEvent(event) {
  if (internalDragState) return internalDragState;
  try {
    const payload = event.dataTransfer.getData('application/x-vfs-item');
    return payload ? JSON.parse(payload) : null;
  } catch {
    return null;
  }
}

function attachLongPressExplorerDrag(element, source) {
  let state = null;

  const reset = () => {
    if (!state) return;
    clearTimeout(state.timer);
    if (state.active) {
      element.classList.remove('dragging', 'long-press-dragging');
      clearExplorerDropState();
    }
    state = null;
  };

  const updateTarget = (touch) => {
    const target = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.file-item, .folder-item, .file-list');
    if (!target || target === element) {
      clearExplorerDropState();
      element.classList.add('dragging', 'long-press-dragging');
      return;
    }

    if (target.classList.contains('folder-item')) {
      const position = getDropPosition(touch, target, true);
      if (position !== 'inside') {
        const targetPath = target.dataset.folderPath;
        const targetParent = getParentPath(targetPath);
        const rootFolder = getProjectRootFolder();
        if (!targetParent.startsWith(rootFolder)) {
          clearExplorerDropState();
          return;
        }
      }
      setExplorerDropState(target, position === 'inside' ? 'drop-inside' : (position === 'before' ? 'drop-before' : 'drop-after'));
    } else if (target.classList.contains('file-item')) {
      const position = getDropPosition(touch, target, false);
      const targetFile = files.find(file => file.id === target.dataset.fileId);
      if (targetFile) {
        const targetParent = getParentPath(targetFile.name);
        const rootFolder = getProjectRootFolder();
        if (!targetParent.startsWith(rootFolder)) {
          clearExplorerDropState();
          return;
        }
      }
      setExplorerDropState(target, position === 'before' ? 'drop-before' : 'drop-after');
    } else {
      if (internalDragState) {
        clearExplorerDropState();
        return;
      }
      setExplorerDropState(target, 'drop-inside');
    }
    element.classList.add('dragging', 'long-press-dragging');
  };

  element.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1 || event.target.closest('button, input')) return;
    const touch = event.touches[0];
    state = {
      active: false,
      startX: touch.clientX,
      startY: touch.clientY,
      timer: setTimeout(() => {
        if (!state) return;
        state.active = true;
        internalDragState = source;
        suppressExplorerClickUntil = Date.now() + 500;
        element.classList.add('dragging', 'long-press-dragging');
      }, EXPLORER_LONG_PRESS_MS)
    };
  }, { passive: true });

  element.addEventListener('touchmove', (event) => {
    if (!state || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!state.active) {
      if (Math.hypot(touch.clientX - state.startX, touch.clientY - state.startY) > 8) reset();
      return;
    }
    event.preventDefault();
    updateTarget(touch);
  }, { passive: false });

  element.addEventListener('touchend', (event) => {
    if (!state) return;
    clearTimeout(state.timer);
    if (!state.active) {
      state = null;
      return;
    }

    event.preventDefault();
    const target = activeExplorerDropElement;
    const position = target?.classList.contains('drop-before')
      ? 'before'
      : (target?.classList.contains('drop-after') ? 'after' : 'inside');

    if (target?.classList.contains('folder-item')) {
      const targetPath = target.dataset.folderPath;
      if (position === 'inside') moveVfsItemToFolder(source, targetPath);
      else reorderVfsItemAround(source, targetPath, position);
    } else if (target?.classList.contains('file-item')) {
      const targetFile = files.find(file => file.id === target.dataset.fileId);
      if (targetFile) reorderVfsItemAround(source, targetFile.name, position);
    } else if (target?.classList.contains('file-list')) {
      moveVfsItemToFolder(source, '');
    }

    internalDragState = null;
    reset();
  }, { passive: false });

  element.addEventListener('touchcancel', () => {
    internalDragState = null;
    reset();
  }, { passive: true });
}

// Keep the current file visible without maintaining a second navigation system.
function renderActiveFileSummary() {
  const summary = document.getElementById('active-file-summary');
  const name = document.getElementById('active-file-name');
  if (!summary || !name) return;

  const file = files.find(candidate => candidate.id === activeFileId && !candidate.isFolder);
  if (!file) {
    name.textContent = t('no_file_selected');
    summary.title = t('choose_file_selector_title');
    summary.setAttribute('aria-label', t('choose_file'));
  } else {
    name.textContent = file.name;
    summary.title = file.name;
    summary.setAttribute('aria-label', t('change_file_aria', { name: file.name }));
  }

  scheduleLucideIcons();
}

// Render the file explorer list
function renderFileExplorer() {
  const fileListContainer = document.getElementById('file-list');
  if (!fileListContainer) return;
  updateEntryHtmlSelector();

  const savedScrollTop = fileListContainer.scrollTop;
  // Re-rendering replaces every row; keep keyboard focus on the same item.
  const focusedRow = document.activeElement?.closest?.('.file-item, .folder-item');
  const focusedKey = focusedRow && fileListContainer.contains(focusedRow)
    ? (focusedRow.dataset.fileId ? `file:${focusedRow.dataset.fileId}` : `folder:${focusedRow.dataset.folderPath}`)
    : '';
  fileListContainer.innerHTML = '';
  fileListContainer.setAttribute('role', 'tree');
  fileListContainer.setAttribute('aria-label', t('explorer_title'));
  if (!fileListContainer.dataset.keyboardReady) {
    fileListContainer.dataset.keyboardReady = 'true';
    fileListContainer.addEventListener('keydown', handleExplorerKeydown);
  }
  activeExplorerDropElement = null;
  fileListContainer.classList.remove('drop-inside');

  fileListContainer.ondragover = (e) => {
    if (dataTransferHasFiles(e)) {
      e.preventDefault();
      if (e.currentTarget === fileListContainer) {
        fileListContainer.classList.add('drop-inside');
      }
    }
  };

  fileListContainer.ondragleave = () => {
    fileListContainer.classList.remove('drop-inside');
  };

  fileListContainer.ondrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    fileListContainer.classList.remove('drop-inside');
    clearExplorerDropState();

    if (isInternalExplorerDrag(e)) {
      const source = getDragSourceFromEvent(e);
      if (source) moveVfsItemToFolder(source, '');
      internalDragState = null;
      return;
    }

    if (typeof showDragDropLoading === 'function') showDragDropLoading(currentLocale === 'es' ? 'Añadiendo archivos...' : 'Adding files...');
    try {
      const addedCount = await addDroppedFilesToProject(snapshotDataTransfer(e.dataTransfer), '');
      finishExternalFileDrag({ keepExplorerOpen: addedCount > 0 });
      if (addedCount > 0) showToast(t('toast_files_added_to_root', { count: addedCount }));
    } catch (error) {
      console.error('Error añadiendo archivos soltados', error);
      finishExternalFileDrag();
      showToast(t('toast_no_valid_import'), 'error');
    }
  };

  const tree = buildFileTree(files);
  const fragment = document.createDocumentFragment();
  renderTreeChildren(tree, fragment, 0);
  fileListContainer.appendChild(fragment);
  scheduleLucideIcons();

  // Exactly one row is reachable with Tab; arrows move between rows and
  // F2/Delete reach the row actions without a tab stop per button.
  fileListContainer.querySelectorAll('button').forEach(button => { button.tabIndex = -1; });
  const rows =Array.from(fileListContainer.querySelectorAll('.file-item, .folder-item'));
  const rowToFocus = focusedKey
    ? rows.find(row => (focusedKey.startsWith('file:') ? `file:${row.dataset.fileId}` : `folder:${row.dataset.folderPath}`) === focusedKey)
    : null;
  const tabStop = rowToFocus || fileListContainer.querySelector('.file-item.active') || rows[0];
  if (tabStop) tabStop.tabIndex = 0;
  rowToFocus?.focus({ preventScroll: true });

  fileListContainer.scrollTop = savedScrollTop;
}

function handleExplorerKeydown(event) {
  const row = event.target.closest?.('.file-item, .folder-item');
  if (!row || event.target !== row) return;
  const rows = Array.from(event.currentTarget.querySelectorAll('.file-item, .folder-item'));
  const index = rows.indexOf(row);
  const focusRow = nextRow => {
    if (!nextRow) return;
    rows.forEach(item => { item.tabIndex = -1; });
    nextRow.tabIndex = 0;
    nextRow.focus();
  };
  const isFolder = row.classList.contains('folder-item');
  const folderPath = row.dataset.folderPath;
  const file = isFolder ? null : files.find(item => item.id === row.dataset.fileId);

  switch (event.key) {
    case 'ArrowDown':
      focusRow(rows[index + 1]);
      break;
    case 'ArrowUp':
      focusRow(rows[index - 1]);
      break;
    case 'Home':
      focusRow(rows[0]);
      break;
    case 'End':
      focusRow(rows[rows.length - 1]);
      break;
    case 'ArrowRight':
    case 'ArrowLeft': {
      if (!isFolder) return;
      const collapse = event.key === 'ArrowLeft';
      if (collapsedFolders.has(folderPath) === collapse) return;
      if (collapse) collapsedFolders.add(folderPath);
      else collapsedFolders.delete(folderPath);
      renderFileExplorer();
      break;
    }
    case 'Enter':
    case ' ':
      if (isFolder) {
        row.click();
      } else if (file) {
        openFile(file.id);
      }
      break;
    case 'F2':
      row.querySelector('.file-item-btn[data-action="rename"], .folder-item-btn[data-action="rename"]')?.click();
      break;
    case 'Delete':
      row.querySelector('[data-action="delete"]')?.click();
      break;
    default:
      return;
  }
  event.preventDefault();
}

// Recursively render tree children
function renderTreeChildren(parentNode, container, depth) {
  // Sort by manual order, then by name for stable imported projects.
  const sortedKeys = Object.keys(parentNode.children).sort((a, b) => {
    const nodeA = parentNode.children[a];
    const nodeB = parentNode.children[b];
    const orderDelta = (nodeA.order || 0) - (nodeB.order || 0);
    if (orderDelta !== 0) return orderDelta;
    return a.localeCompare(b);
  });

  sortedKeys.forEach(key => {
    const node = parentNode.children[key];
    if (node.isFolder) {
      const isCollapsed = collapsedFolders.has(node.path);
      const isProjectRootFolder = depth === 0 && isProjectRootFolderPath(node.path);

      // Create folder element
      const folderDiv = document.createElement('div');
      folderDiv.className = 'folder-item';
      folderDiv.dataset.folderPath = node.path;
      folderDiv.tabIndex = -1;
      folderDiv.setAttribute('role', 'treeitem');
      folderDiv.setAttribute('aria-level', String(depth + 1));
      folderDiv.setAttribute('aria-expanded', String(!isCollapsed));
      folderDiv.setAttribute('aria-label', node.name);

      const infoDiv = document.createElement('div');
      infoDiv.className = 'folder-item-info';

      // Chevron
      const chevron = document.createElement('i');
      chevron.setAttribute('data-lucide', 'chevron-down');
      chevron.className = `folder-chevron ${isCollapsed ? 'collapsed' : ''}`;

      // Folder icon
      const folderIcon = document.createElement('i');
      folderIcon.setAttribute('data-lucide', isCollapsed ? 'folder' : 'folder-open');

      // Folder name
      const nameSpan = document.createElement('span');
      nameSpan.className = 'folder-name';
      nameSpan.textContent = node.name;

      infoDiv.append(chevron, folderIcon, nameSpan);

      // Actions
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'folder-item-actions';

      const newFileBtn = document.createElement('button');
      newFileBtn.className = 'folder-item-btn';
      newFileBtn.title = t('new_file');
      newFileBtn.setAttribute('aria-label', t('new_file'));
      newFileBtn.innerHTML = '<i data-lucide="file-plus"></i>';
      newFileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        createNewFile(node.path);
      });

      const newFolderBtn = document.createElement('button');
      newFolderBtn.className = 'folder-item-btn';
      newFolderBtn.title = t('new_folder');
      newFolderBtn.setAttribute('aria-label', t('new_folder'));
      newFolderBtn.innerHTML = '<i data-lucide="folder-plus"></i>';
      newFolderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        createNewFolder(node.path);
      });

      const renameBtn = document.createElement('button');
      renameBtn.className = 'folder-item-btn';
      renameBtn.title = t('rename');
      renameBtn.dataset.action = 'rename';
      renameBtn.setAttribute('aria-label', t('rename_folder'));
      renameBtn.innerHTML = '<i data-lucide="edit-2"></i>';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renameFolderInline(node, folderDiv);
      });

      actionsDiv.append(newFileBtn, newFolderBtn, renameBtn);

      if (!isProjectRootFolder) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'folder-item-btn';
        deleteBtn.title = t('delete');
        deleteBtn.dataset.action = 'delete';
        deleteBtn.setAttribute('aria-label', t('delete_folder'));
        deleteBtn.innerHTML = '<i data-lucide="trash"></i>';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteFolder(node.path);
        });
        actionsDiv.appendChild(deleteBtn);
      }
      folderDiv.append(infoDiv, actionsDiv);

      folderDiv.draggable = true;
      folderDiv.addEventListener('dragstart', (e) => {
        internalDragState = { kind: 'folder', id: node.id, path: node.path };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-vfs-item', JSON.stringify(internalDragState));
        folderDiv.classList.add('dragging');
      });
      folderDiv.addEventListener('dragend', () => {
        internalDragState = null;
        clearExplorerDropState();
      });
      attachLongPressExplorerDrag(folderDiv, { kind: 'folder', id: node.id, path: node.path });
      folderDiv.addEventListener('dragover', (e) => {
        if (!isInternalExplorerDrag(e) && !dataTransferHasFiles(e)) return;
        const position = getDropPosition(e, folderDiv, true);
        if (position !== 'inside' && isInternalExplorerDrag(e)) {
          const targetParent = getParentPath(node.path);
          const rootFolder = getProjectRootFolder();
          if (!targetParent.startsWith(rootFolder)) {
            return;
          }
        }
        e.preventDefault();
        e.stopPropagation();
        setExplorerDropState(folderDiv, position === 'inside' ? 'drop-inside' : (position === 'before' ? 'drop-before' : 'drop-after'));
      });
      folderDiv.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const position = folderDiv.classList.contains('drop-before') ? 'before' : (folderDiv.classList.contains('drop-after') ? 'after' : 'inside');
        clearExplorerDropState();

        if (isInternalExplorerDrag(e)) {
          const source = getDragSourceFromEvent(e);
          if (source) {
            if (position === 'inside') moveVfsItemToFolder(source, node.path);
            else reorderVfsItemAround(source, node.path, position);
          }
          internalDragState = null;
          return;
        }

        const targetFolder = position === 'inside' ? node.path : getParentPath(node.path);

        if (position === 'inside') collapsedFolders.delete(node.path);
        if (typeof showDragDropLoading === 'function') showDragDropLoading(currentLocale === 'es' ? 'Añadiendo archivos...' : 'Adding files...');
        let addedCount = 0;
        try {
          addedCount = await addDroppedFilesToProject(snapshotDataTransfer(e.dataTransfer), targetFolder);
          finishExternalFileDrag({ keepExplorerOpen: addedCount > 0 });
        } catch (error) {
          console.error('Error añadiendo archivos a la carpeta', error);
          finishExternalFileDrag();
          showToast(t('toast_no_valid_import'), 'error');
        }
        if (addedCount > 0) {
          const rootFolder = getProjectRootFolder();
          if (targetFolder === rootFolder) {
            showToast(t('toast_files_added_to_root', { count: addedCount }));
          } else {
            const folderBaseName = targetFolder.split('/').filter(Boolean).pop() || '';
            showToast(t('toast_files_added_to_folder', { count: addedCount, name: folderBaseName }));
          }
        }
      });

      // Expand / Collapse on click (but not when clicking actions)
      folderDiv.addEventListener('click', (e) => {
        if (Date.now() < suppressExplorerClickUntil) return;
        if (e.target.closest('.folder-item-actions')) return;
        if (collapsedFolders.has(node.path)) {
          collapsedFolders.delete(node.path);
        } else {
          collapsedFolders.add(node.path);
        }
        renderFileExplorer();
      });

      // Double click to rename
      infoDiv.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        renameFolderInline(node, folderDiv);
      });

      container.appendChild(folderDiv);

      // Children container
      const childrenDiv = document.createElement('div');
      childrenDiv.className = `folder-children ${isCollapsed ? 'collapsed' : ''}`;
      container.appendChild(childrenDiv);

      if (!isCollapsed) {
        renderTreeChildren(node, childrenDiv, depth + 1);
      }
    } else {
      // File item
      const file = node.fileRef;
      const isActive = file.id === activeFileId;

      const fileDiv = document.createElement('div');
      fileDiv.className = `file-item ${isActive ? 'active' : ''}`;
      fileDiv.dataset.fileId = file.id;
      fileDiv.tabIndex = -1;
      fileDiv.setAttribute('role', 'treeitem');
      fileDiv.setAttribute('aria-level', String(depth + 1));
      fileDiv.setAttribute('aria-selected', String(isActive));
      fileDiv.setAttribute('aria-label', node.name);

      const infoDiv = document.createElement('div');
      infoDiv.className = 'file-item-info';

      // Chevron placeholder for alignment
      const chevronPlaceholder = document.createElement('div');
      chevronPlaceholder.className = 'file-chevron-placeholder';

      // Icon
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', getIconForFilename(file.name));

      // Base name
      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-item-name';
      nameSpan.textContent = node.name;

      infoDiv.append(chevronPlaceholder, icon, nameSpan);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'file-item-actions';

      // Rename button
      const renameBtn = document.createElement('button');
      renameBtn.className = 'file-item-btn';
      renameBtn.title = t('rename');
      renameBtn.dataset.action = 'rename';
      renameBtn.setAttribute('aria-label', t('rename_file'));
      renameBtn.innerHTML = '<i data-lucide="edit-2"></i>';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renameFileInline(file.id, fileDiv);
      });

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'file-item-btn';
      deleteBtn.title = t('delete');
      deleteBtn.dataset.action = 'delete';
      deleteBtn.setAttribute('aria-label', t('delete_file'));
      deleteBtn.innerHTML = '<i data-lucide="trash"></i>';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFile(file.id);
      });

      const currentEntryFile = getEntryFile();
      const isEntry = currentEntryFile && file.id === currentEntryFile.id;
      const isHtmlEntryCandidate = isHtmlFile(file);
      if (isEntry) {
        fileDiv.classList.add('preview-entry');
      }
      if (isEntry && projectPreviewMissingPath) {
        fileDiv.classList.add('preview-entry-warning');
      }
      const previewBtn = document.createElement('button');
      previewBtn.className = 'file-item-btn';
      if (isEntry) {
        previewBtn.classList.add('preview-entry-btn');
      }
      previewBtn.title = isEntry
        ? t('reload_preview')
        : t('open_preview');
      previewBtn.setAttribute('aria-label', previewBtn.title);
      previewBtn.innerHTML = '<i data-lucide="eye"></i>';
      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setSelectedEntryFile(file.id);
      });

      if (isHtmlEntryCandidate) {
        actionsDiv.appendChild(previewBtn);
      }
      if (!isEntry) {
        actionsDiv.appendChild(renameBtn);
        actionsDiv.appendChild(deleteBtn);
      } else {
        actionsDiv.appendChild(renameBtn);
      }

      fileDiv.append(infoDiv, actionsDiv);

      fileDiv.draggable = true;
      fileDiv.addEventListener('dragstart', (e) => {
        internalDragState = { kind: 'file', id: file.id, path: file.name };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-vfs-item', JSON.stringify(internalDragState));
        fileDiv.classList.add('dragging');
      });
      fileDiv.addEventListener('dragend', () => {
        internalDragState = null;
        clearExplorerDropState();
      });
      attachLongPressExplorerDrag(fileDiv, { kind: 'file', id: file.id, path: file.name });
      fileDiv.addEventListener('dragover', (e) => {
        if (!isInternalExplorerDrag(e) && !dataTransferHasFiles(e)) return;
        if (isInternalExplorerDrag(e)) {
          const targetParent = getParentPath(file.name);
          const rootFolder = getProjectRootFolder();
          if (!targetParent.startsWith(rootFolder)) {
            return;
          }
        }
        e.preventDefault();
        e.stopPropagation();
        const position = getDropPosition(e, fileDiv, false);
        setExplorerDropState(fileDiv, position === 'before' ? 'drop-before' : 'drop-after');
      });
      fileDiv.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const position = fileDiv.classList.contains('drop-before') ? 'before' : 'after';
        clearExplorerDropState();

        if (isInternalExplorerDrag(e)) {
          const source = getDragSourceFromEvent(e);
          if (source) reorderVfsItemAround(source, file.name, position);
          internalDragState = null;
          return;
        }

        const parentPath = getParentPath(file.name);
        if (typeof showDragDropLoading === 'function') showDragDropLoading(currentLocale === 'es' ? 'Añadiendo archivos...' : 'Adding files...');
        const addedCount = await addDroppedFilesToProject(snapshotDataTransfer(e.dataTransfer), parentPath);
        finishExternalFileDrag({ keepExplorerOpen: addedCount > 0 });
        if (addedCount > 0) {
          const rootFolder = getProjectRootFolder();
          if (parentPath === rootFolder || !parentPath) {
            showToast(t('toast_files_added_to_root', { count: addedCount }));
          } else {
            const folderBaseName = parentPath.split('/').filter(Boolean).pop() || '';
            showToast(t('toast_files_added_to_folder', { count: addedCount, name: folderBaseName }));
          }
        }
      });

      // Click to open file
      fileDiv.addEventListener('click', () => {
        if (Date.now() < suppressExplorerClickUntil) return;
        handleExplorerFileClick(file);
      });

      container.appendChild(fileDiv);
    }
  });
}

// Create a new virtual folder
function createNewFolder(parentPath = '') {
  if (!parentPath) {
    parentPath = getProjectRootFolder();
  }
  saveHistoryState();
  let baseName = t('new_folder').toLowerCase().replace(/\s+/g, '-');
  let folderName = parentPath + baseName + '/';
  let counter = 1;
  while (files.some(f => f.name.toLowerCase() === folderName.toLowerCase())) {
    counter++;
    baseName = `${t('new_folder').toLowerCase().replace(/\s+/g, '-')}-${counter}`;
    folderName = parentPath + baseName + '/';
  }

  const newFolder = createFolderRecord(folderName);

  files.push(newFolder);

  renderFileExplorer();

  // Auto-expand parent if collapsed
  if (parentPath && collapsedFolders.has(parentPath)) {
    collapsedFolders.delete(parentPath);
    renderFileExplorer();
  }

  // Trigger inline rename for the new folder
  const folderElement = document.querySelector(`.folder-item[data-folder-path="${folderName}"]`);
  if (folderElement) {
    const tree = buildFileTree(files);
    const node = findFolderNodeByPath(tree, folderName);
    if (node) {
      renameFolderInline(node, folderElement);
    }
  }
  window.scheduleRecoverySave?.();
}

// Rename folder inline
function renameFolderInline(node, folderElement) {
  const infoDiv = folderElement.querySelector('.folder-item-info');
  const nameSpan = folderElement.querySelector('.folder-name');
  if (!infoDiv || !nameSpan) return;

  const currentBaseName = node.name;
  const oldPath = node.path;

  const parts = oldPath.split('/').filter(Boolean);
  parts.pop(); // remove folder name
  const parentPath = parts.length > 0 ? parts.join('/') + '/' : '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'folder-rename-input';
  input.value = currentBaseName;

  infoDiv.replaceChild(input, nameSpan);
  input.focus();
  input.select();

  let finished = false;
  const finishRename = () => {
    if (finished) return;
    finished = true;

    const newBaseName = input.value.trim();
    if (newBaseName && newBaseName !== currentBaseName) {
      if (!isValidFileName(newBaseName)) {
        showToast(t('toast_folder_name_invalid'), 'error');
        infoDiv.replaceChild(nameSpan, input);
        return;
      }
      const newPath = parentPath + newBaseName + '/';

      const exists = files.some(f => f.isFolder && f.name.toLowerCase() === newPath.toLowerCase());
      if (exists) {
        showToast(t('toast_folder_exists_in_location'), 'error');
        infoDiv.replaceChild(nameSpan, input);
      } else {
        saveHistoryState();
        const pathChanges = files
          .filter(f => !f.isFolder && f.name.startsWith(oldPath))
          .map(f => ({
            oldPath: f.name,
            newPath: newPath + f.name.substring(oldPath.length)
          }));

        // Update paths recursivelly
        files.forEach(f => {
          if (f.name.startsWith(oldPath)) {
            const relativePart = f.name.substring(oldPath.length);
            f.name = newPath + relativePart;
          }
        });

        if (collapsedFolders.has(oldPath)) {
          collapsedFolders.delete(oldPath);
          collapsedFolders.add(newPath);
        }

        const updatedRefs = applyPathReferenceChanges(pathChanges);
        cleanupVirtualBlobUrlCache();
        showToast(t('toast_folder_renamed', { name: newBaseName }));
        if (updatedRefs > 0) showToast(t('toast_references_updated', { count: updatedRefs }), 'info');
        renderFileExplorer();
        renderActiveFileSummary();
        updateFileNameExtension();
        updateEditorPlaceholder();
        updatePreview();
        window.scheduleRecoverySave?.();
      }
    } else {
      infoDiv.replaceChild(nameSpan, input);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      finishRename();
    } else if (e.key === 'Escape') {
      input.value = currentBaseName;
      finishRename();
    }
  });

  input.addEventListener('blur', finishRename);
}

// Delete folder and all its contents
function deleteFolder(folderPath) {
  if (isProjectRootFolderPath(folderPath)) {
    return;
  }

  const folderName = folderPath.split('/').filter(Boolean).pop();
  const toDelete = files.filter(f => f.name.startsWith(folderPath));

  const currentEntryFile = getEntryFile();
  const hasCurrentEntry = currentEntryFile && toDelete.some(f => f.id === currentEntryFile.id);
  if (hasCurrentEntry) {
    showToast(t('toast_cannot_delete_folder_preview'), 'error');
    return;
  }

  // Save history state before deletion so it can be undone
  saveHistoryState();

  toDelete.forEach(f => {
    if (!f.isFolder && monacoLoaded && fileModels[f.id]) {
      fileModels[f.id].dispose();
      delete fileModels[f.id];
    }
  });

  const deletedIds = toDelete.map(f => f.id);
  openFileIds = openFileIds.filter(id => !deletedIds.includes(id));

  if (deletedIds.includes(activeFileId)) {
    if (openFileIds.length > 0) {
      const lastId = openFileIds[openFileIds.length - 1];
      activeFileId = lastId;
      if (monacoLoaded && fileModels[lastId]) {
        editor.setModel(fileModels[lastId]);
      } else if (!monacoLoaded) {
        const file = files.find(f => f.id === lastId);
        fallbackTextarea.value = file ? file.content : '';
      }
    } else {
      activeFileId = '';
      if (monacoLoaded) {
        editor.setModel(null);
      } else {
        fallbackTextarea.value = '';
      }
    }
  }

  files = files.filter(f => !f.name.startsWith(folderPath));
  syncSelectedEntryFile();
  collapsedFolders.delete(folderPath);
  cleanupVirtualBlobUrlCache();

  showUndoableToast(t('toast_folder_deleted', { name: folderName }));
  renderFileExplorer();
  renderActiveFileSummary();
  updateFileNameExtension();
  updateEditorPlaceholder();
  updatePreview();
  window.scheduleRecoverySave?.();
}

// Create a new virtual file
function createNewFile(parentPath = '') {
  if (!parentPath) {
    parentPath = getProjectRootFolder();
  }
  saveHistoryState();
  let baseName = t('default_file_name');
  let fullName = parentPath + baseName;
  let counter = 1;
  while (files.some(f => f.name.toLowerCase() === fullName.toLowerCase())) {
    counter++;
    baseName = `${t('default_file_name')}-${counter}`;
    fullName = parentPath + baseName;
  }

  const newFile = createTextFileRecord(fullName, '');
  const fileId = newFile.id;
  files.push(newFile);

  if (monacoLoaded) createModelForFile(newFile);

  // Open the file (renders tabs & explorer)
  openFile(fileId, { autoCollapse: false });

  // Auto-expand parent if collapsed
  if (parentPath && collapsedFolders.has(parentPath)) {
    collapsedFolders.delete(parentPath);
    renderFileExplorer();
  }

  // Trigger inline rename immediately
  const itemElement = document.querySelector(`.file-item[data-file-id="${fileId}"]`);
  if (itemElement) {
    renameFileInline(fileId, itemElement);
  }
  window.scheduleRecoverySave?.();
}

// Delete a virtual file
function deleteFile(fileId) {
  const file = files.find(f => f.id === fileId);
  if (!file) return;
  const deletedFileName = file.name;
  const wasActiveFile = activeFileId === fileId;

  const currentEntryFile = getEntryFile();
  if (currentEntryFile && file.id === currentEntryFile.id) {
    showToast(t('toast_cannot_delete_file_preview'), 'error');
    return;
  }

  // Save history state before deletion so it can be undone
  saveHistoryState();

  if (monacoLoaded && fileModels[fileId]) {
    fileModels[fileId].dispose();
    delete fileModels[fileId];
  }

  files = files.filter(f => f.id !== fileId);
  syncSelectedEntryFile();
  closeFile(fileId);
  if (wasActiveFile && !activeFileId) {
    showCodeEditor();
  }
  cleanupVirtualBlobUrlCache();

  showUndoableToast(t('toast_file_deleted', { name: deletedFileName.split('/').pop() }));
  renderFileExplorer();
  renderActiveFileSummary();
  updateFileNameExtension();
  updateEditorPlaceholder();
  updatePreview();
  window.scheduleRecoverySave?.();
}

// Inline Rename helper for files
function renameFileInline(fileId, itemElement) {
  const file = files.find(f => f.id === fileId);
  if (!file) return;

  const infoDiv = itemElement.querySelector('.file-item-info');
  const nameSpan = itemElement.querySelector('.file-item-name');
  if (!infoDiv || !nameSpan) return;

  const parts = file.name.split('/');
  const baseName = parts.pop();
  const parentPath = parts.length > 0 ? parts.join('/') + '/' : '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-rename-input';
  input.value = baseName;

  infoDiv.replaceChild(input, nameSpan);
  input.focus();
  input.select();

  let finished = false;
  const finishRename = () => {
    if (finished) return;
    finished = true;

    const newBaseName = input.value.trim();
    if (newBaseName && newBaseName !== baseName) {
      if (!isValidFileName(newBaseName)) {
        showToast(t('toast_file_name_invalid'), 'error');
        infoDiv.replaceChild(nameSpan, input);
        return;
      }
      const newFullName = parentPath + newBaseName;
      // Validate
      const exists = files.some(f => f.name.toLowerCase() === newFullName.toLowerCase() && f.id !== fileId);
      if (exists) {
        showToast(t('toast_file_exists_in_folder'), 'error');
        infoDiv.replaceChild(nameSpan, input);
      } else {
        saveHistoryState();
        const oldFullName = file.name;
        file.name = newFullName;
        file.type = getFileExtension(newFullName) || file.type;
        file.mimeType = getMimeTypeForFilename(newFullName);
        file.isBinary = !isTextFilename(newFullName) && Boolean(file.blob);
        syncSelectedEntryFile();

        // Update Monaco model language if extension changed
        if (monacoLoaded && fileModels[fileId]) {
          const newLang = getLanguageFromFilename(newFullName);
          monaco.editor.setModelLanguage(fileModels[fileId], newLang);
        }

        const updatedRefs = applyPathReferenceChanges([{ oldPath: oldFullName, newPath: newFullName }]);
        cleanupVirtualBlobUrlCache();
        showToast(t('toast_file_renamed', { name: newBaseName }));
        if (updatedRefs > 0) showToast(t('toast_references_updated', { count: updatedRefs }), 'info');
        renderFileExplorer();
        renderActiveFileSummary();
        updateFileNameExtension();
        updateEditorPlaceholder();
        updatePreview();
        window.scheduleRecoverySave?.();
      }
    } else {
      infoDiv.replaceChild(nameSpan, input);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      finishRename();
    } else if (e.key === 'Escape') {
      input.value = baseName;
      finishRename();
    }
  });

  input.addEventListener('blur', finishRename);
}

// Toggle file explorer sidebar
function toggleFileExplorer(showToastFlag = true) {
  const fileExplorer = document.getElementById('file-explorer');
  const btnToggleExplorer = document.getElementById('btn-toggle-explorer');
  if (!fileExplorer) return;

  isExplorerCollapsed = !isExplorerCollapsed;

  if (isExplorerCollapsed) {
    fileExplorer.classList.add('collapsed');
    setTimeout(() => {
      if (isExplorerCollapsed) fileExplorer.style.display = 'none';
    }, 200);
    btnToggleExplorer?.classList.remove('active');
  } else {
    fileExplorer.style.display = 'flex';
    setTimeout(() => {
      if (!isExplorerCollapsed) fileExplorer.classList.remove('collapsed');
    }, 10);
    btnToggleExplorer?.classList.add('active');
  }

  setTimeout(() => {
    if (editor && typeof editor.layout === 'function') {
      editor.layout();
    }
  }, 250);
}

// Helper to update filename extension in the editor title
function updateFileNameExtension() {
  const extSpan = document.querySelector('.filename-extension');
  if (!extSpan) return;

  if (editorMode === 'unified') {
    extSpan.textContent = '.html';
  } else {
    const file = files.find(f => f.id === activeFileId);
    if (file) {
      const ext = getFileExtension(file.name);
      extSpan.textContent = ext ? `.${ext}` : '';
    } else {
      extSpan.textContent = '';
    }
  }
}

// Helper to check if a project only contains default files
function isSimpleProject() {
  const defaultNames = new Set([
    'proyecto/index.html', 'proyecto/styles.css', 'proyecto/script.js',
    'project/index.html', 'project/styles.css', 'project/script.js'
  ]);
  return files.every(file => defaultNames.has(file.name) || file.isFolder);
}

// Init editor mode events
function initEditorModeSelector() {
  const btnUnified = document.getElementById('btn-mode-unified');
  const btnSplit = document.getElementById('btn-mode-split');
  const btnToggleExplorer = document.getElementById('btn-toggle-explorer');
  const btnUploadAsset = document.getElementById('btn-upload-asset');
  const btnNewFile = document.getElementById('btn-new-file');
  const btnNewFolder = document.getElementById('btn-new-folder');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');

  if (btnUnified) {
    btnUnified.addEventListener('click', () => switchEditorMode('unified'));
  }
  if (btnSplit) {
    btnSplit.addEventListener('click', () => switchEditorMode('split'));
  }
  if (btnToggleExplorer) {
    btnToggleExplorer.addEventListener('click', () => {
      if (window.innerWidth > 768) {
        if (editorMode === 'unified') {
          switchEditorMode('split');
        } else {
          toggleFileExplorer();
        }
      } else {
        toggleFileExplorer();
      }
    });
  }
  const activeFileSummary = document.getElementById('active-file-summary');
  if (activeFileSummary) {
    activeFileSummary.addEventListener('click', toggleFileExplorer);
  }
  if (btnUploadAsset && assetInput) {
    btnUploadAsset.addEventListener('click', () => {
      pendingAssetTargetPath = '';
      assetInput.click();
    });
  }
  if (btnNewFile) {
    btnNewFile.addEventListener('click', () => createNewFile(''));
  }
  if (btnNewFolder) {
    btnNewFolder.addEventListener('click', () => createNewFolder(''));
  }
  if (btnUndo) {
    btnUndo.addEventListener('click', triggerUndo);
  }
  if (btnRedo) {
    btnRedo.addEventListener('click', triggerRedo);
  }

  // Set initial state of undo/redo buttons
  updateHistoryButtons();

  // Permite desplazar la barra de pestañas horizontalmente usando la rueda del ratón
}
