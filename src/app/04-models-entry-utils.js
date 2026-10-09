function normalizeFileRecord(file) {
  if (file.isFolder) {
    file.name = normalizeProjectPath(file.name, { folder: true });
    file.type = 'folder';
    file.mimeType = 'inode/directory';
    file.size = 0;
  } else {
    file.name = normalizeProjectPath(file.name);
    file.type = getFileExtension(file.name) || file.type || 'plaintext';
    file.mimeType = file.mimeType || getMimeTypeForFilename(file.name);
    file.isBinary = Boolean(file.isBinary) || (!isTextFilename(file.name) && Boolean(file.blob));
    if (!file.isBinary && typeof file.content !== 'string') {
      file.content = String(file.content || '');
    }
    if (typeof file.size !== 'number') {
      file.size = file.isBinary && file.blob ? file.blob.size : new Blob([file.content || '']).size;
    }
  }
  if (typeof file.order !== 'number') {
    file.order = nextFileOrder++;
  }
  return file;
}

function ensureParentFoldersForPath(path) {
  const parts = normalizeProjectPath(path).split('/').filter(Boolean);
  parts.pop();
  let currentPath = '';
  for (const part of parts) {
    currentPath += `${part}/`;
    if (!files.some(file => file.isFolder && file.name.toLowerCase() === currentPath.toLowerCase())) {
      files.push(createFolderRecord(currentPath));
    }
  }
}

function normalizeProjectFiles() {
  files.forEach(normalizeFileRecord);
  const existingFolderPaths = new Set(
    files
      .filter(file => file.isFolder)
      .map(file => normalizeProjectPath(file.name, { folder: true }).toLowerCase())
  );
  const foldersToAdd = [];

  files.forEach(file => {
    if (file.isFolder) return;
    const parts = normalizeProjectPath(file.name).split('/').filter(Boolean);
    parts.pop();

    let currentPath = '';
    for (const part of parts) {
      currentPath += `${part}/`;
      const lookupPath = currentPath.toLowerCase();
      if (!existingFolderPaths.has(lookupPath)) {
        existingFolderPaths.add(lookupPath);
        foldersToAdd.push(createFolderRecord(currentPath));
      }
    }
  });

  if (foldersToAdd.length > 0) {
    files.push(...foldersToAdd);
  }
  files.forEach(normalizeFileRecord);
  nextFileOrder = Math.max(1, ...files.map(file => file.order || 0)) + 1;
  if (typeof preloadFontDataUrls === 'function') {
    preloadFontDataUrls();
  }
}

function createModelForFile(file) {
  if (!monacoLoaded || !isEditableFile(file)) return null;
  const language = getLanguageFromFilename(file.name);
  const fileId = file.id;
  const model = monaco.editor.createModel(file.content || '', language);
  fileModels[fileId] = model;
  model.onDidChangeContent(() => {
    // History replaces file records with clones.  Resolve by id on every
    // event so an old listener can never keep mutating a discarded object.
    const currentFile = files.find(item => item.id === fileId);
    if (!currentFile) return;
    const previousContent = currentFile.content || '';
    const nextContent = model.getValue();
    if (!isRestoringHistory) {
      window.cancelPendingImportOperations?.();
      handleTextChange({
        contentOverrides: { [fileId]: previousContent },
        unifiedContent: editorMode === 'unified' ? previousContent : undefined
      });
    }
    currentFile.content = nextContent;
    currentFile.size = new Blob([nextContent]).size;
    markProjectPreviewDirty(currentFile.name);
    window.scheduleRecoverySave?.();
    updateEditorPlaceholder();
    schedulePreviewUpdate({ force: false });
  });
  return model;
}

function disposeAllFileModels() {
  if (!monacoLoaded) return;
  for (const model of Object.values(fileModels)) {
    model.dispose();
  }
  for (const key in fileModels) {
    delete fileModels[key];
  }
}

function syncModelsForFiles() {
  if (!monacoLoaded) return;
  files.forEach(file => {
    if (
      isEditableFile(file) &&
      (openFileIds.includes(file.id) || file.id === activeFileId) &&
      !fileModels[file.id]
    ) {
      createModelForFile(file);
    }
  });
}

function getUniquePath(desiredPath, currentId = null, { folder = false } = {}) {
  const cleanPath = normalizeProjectPath(desiredPath, { folder });
  if (!cleanPath) return cleanPath;
  const parentPath = getParentPath(cleanPath);
  const baseName = getBaseName(cleanPath);
  const dotIndex = folder ? -1 : baseName.lastIndexOf('.');
  const stem = dotIndex > 0 ? baseName.substring(0, dotIndex) : baseName;
  const ext = dotIndex > 0 ? baseName.substring(dotIndex) : '';
  let candidate = cleanPath;
  let counter = 2;

  while (files.some(file => file.id !== currentId && file.name.toLowerCase() === candidate.toLowerCase())) {
    candidate = normalizeProjectPath(`${parentPath}${stem}-${counter}${ext}`, { folder });
    counter++;
  }

  return candidate;
}

function shouldReadFileAsText(file) {
  return isTextFilename(file.name) || /^text\//i.test(file.type || '');
}

function isHtmlFile(file) {
  if (!file || file.isFolder) return false;
  const ext = getFileExtension(file.name);
  return ext === 'html' || ext === 'htm';
}

function getHtmlFiles() {
  return files
    .filter(isHtmlFile)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function createRecordFromBrowserFile(file, targetPath = '') {
  const baseName = file.name || 'archivo';
  const desiredPath = joinProjectPath(targetPath, baseName);
  const uniquePath = getUniquePath(desiredPath);

  if (shouldReadFileAsText(file)) {
    return createTextFileRecord(uniquePath, await readTextFile(file), {
      mimeType: file.type || getMimeTypeForFilename(uniquePath),
      size: file.size
    });
  }

  const blob = file.slice(0, file.size, file.type || getMimeTypeForFilename(uniquePath));
  return createBinaryFileRecord(uniquePath, blob, {
    mimeType: file.type || getMimeTypeForFilename(uniquePath),
    size: file.size
  });
}

function getProjectRootFolder() {
  if (files.length === 0) return t('default_folder_name') + '/';
  for (const file of files) {
    const parts = file.name.split('/');
    if (parts.length > 0 && parts[0]) {
      return parts[0] + '/';
    }
  }
  return t('default_folder_name') + '/';
}

function isProjectRootFolderPath(folderPath) {
  return normalizeProjectPath(folderPath, { folder: true }) === getProjectRootFolder();
}

function scoreHtmlFile(file, rootFolder) {
  if (!file || file.isFolder) return -999999;

  let score = 0;

  // 1. Filename matching
  const name = file.name || '';
  const parts = name.split('/');
  const baseName = parts[parts.length - 1] || '';
  const baseLower = baseName.toLowerCase();

  if (baseLower === 'index.html' || baseLower === 'index.htm') {
    score += 100;
  } else if (
    baseLower === 'main.html' || baseLower === 'main.htm' ||
    baseLower === 'app.html' || baseLower === 'app.htm' ||
    baseLower === 'home.html' || baseLower === 'home.htm'
  ) {
    score += 50;
  } else {
    score += 10;
  }

  // 2. Depth calculation relative to project root
  let relativePath = name;
  if (rootFolder && name.startsWith(rootFolder)) {
    relativePath = name.substring(rootFolder.length);
  }
  const relParts = relativePath.split('/').filter(Boolean);
  const depth = Math.max(0, relParts.length - 1);
  score -= depth * 15;

  // 3. Folder segment penalties and rewards
  for (let i = 0; i < relParts.length - 1; i++) {
    const segment = relParts[i].toLowerCase();

    // Ignored / Excluded folders
    if (
      segment === 'node_modules' || segment === 'vendor' || segment === 'bower_components' ||
      segment === 'test' || segment === 'tests' || segment === 'spec' ||
      segment === 'coverage' || segment === 'docs' || segment === 'temp' ||
      segment === 'tmp' || segment === 'cache' || segment === '__tests__'
    ) {
      score -= 200;
    }
    // Component/fragment folders
    else if (
      segment === 'components' || segment === 'templates' || segment === 'fragments' ||
      segment === 'partials' || segment === 'views' || segment === 'widgets'
    ) {
      score -= 100;
    }
    // Build output folders
    else if (
      segment === 'dist' || segment === 'build' || segment === 'out' || segment === 'target'
    ) {
      score -= 30;
    }
    // Source / Public folders
    else if (
      segment === 'src' || segment === 'public' || segment === 'app'
    ) {
      score += 15;
    }
  }

  // 4. Content analysis (if file has text content)
  const content = file.content;
  if (typeof content === 'string') {
    const contentLen = content.length;
    if (contentLen < 30) {
      score -= 30;
    } else {
      const contentLower = content.toLowerCase();

      // Page structure tags
      if (contentLower.includes('<!doctype html>')) score += 30;
      if (contentLower.includes('<html')) score += 20;
      if (contentLower.includes('<body')) score += 20;
      if (contentLower.includes('<head')) score += 10;

      // Scripts/Links
      if (contentLower.includes('<script')) score += 15;
      if (contentLower.includes('<link')) score += 15;

      // Framework mounts
      if (
        contentLower.includes('id="app"') ||
        contentLower.includes('id="root"') ||
        contentLower.includes('<router-view')
      ) {
        score += 15;
      }

      // Template indicators
      if (
        contentLower.includes('{{') ||
        contentLower.includes('{%') ||
        contentLower.includes('<%')
      ) {
        score -= 40;
      }
    }
  }

  return score;
}

function detectBestEntryFile(htmlFiles) {
  if (!htmlFiles || htmlFiles.length === 0) return null;
  const rootFolder = getProjectRootFolder();

  let bestFile = null;
  let maxScore = -Infinity;

  for (const file of htmlFiles) {
    const score = scoreHtmlFile(file, rootFolder);
    if (score > maxScore) {
      maxScore = score;
      bestFile = file;
    }
  }

  return bestFile;
}

function getEntryFile() {
  const selectedEntryFile = files.find(f => f.id === selectedEntryFileId && isHtmlFile(f));
  if (selectedEntryFile) {
    return selectedEntryFile;
  }

  const htmlFiles = getHtmlFiles();
  let entryFile = detectBestEntryFile(htmlFiles);
  if (!entryFile) {
    entryFile = files.find(f => !f.isFolder && isEditableFile(f));
  }
  if (!entryFile) {
    entryFile = files.find(f => !f.isFolder);
  }
  return entryFile || null;
}

function syncSelectedEntryFile() {
  const htmlFiles = getHtmlFiles();
  const selectedStillValid = htmlFiles.some(file => file.id === selectedEntryFileId);
  if (!selectedStillValid) {
    const preferred = detectBestEntryFile(htmlFiles);
    selectedEntryFileId = preferred ? preferred.id : '';
  }
  return htmlFiles;
}

function updateEntryHtmlSelector() {
  syncSelectedEntryFile();
}

function setSelectedEntryFile(fileId) {
  const file = files.find(item => item.id === fileId);
  if (!isHtmlFile(file)) return;

  if (pendingHtmlOpenClick) {
    clearTimeout(pendingHtmlOpenClick.timeoutId);
    pendingHtmlOpenClick = null;
  }
  selectedEntryFileId = file.id;
  resetProjectPreviewLocation();
  previewLifecycle.projectPath = normalizeProjectPath(file.name);
  projectPreviewMissingPath = '';
  projectPreviewNotifiedMissingPath = '';
  projectPreviewLastUrl = '';
  updateEntryHtmlSelector();
  renderFileExplorer();
  updatePreview({ full: false });
}

function handleExplorerFileClick(file) {
  if (!isHtmlFile(file)) {
    openFile(file.id);
    return;
  }

  if (pendingHtmlOpenClick && pendingHtmlOpenClick.fileId === file.id) {
    clearTimeout(pendingHtmlOpenClick.timeoutId);
    pendingHtmlOpenClick = null;
    setSelectedEntryFile(file.id);
    return;
  }

  if (pendingHtmlOpenClick) {
    clearTimeout(pendingHtmlOpenClick.timeoutId);
    const previousFileId = pendingHtmlOpenClick.fileId;
    pendingHtmlOpenClick = null;
    openFile(previousFileId);
  }

  pendingHtmlOpenClick = {
    fileId: file.id,
    timeoutId: setTimeout(() => {
      pendingHtmlOpenClick = null;
      openFile(file.id);
    }, 220)
  };
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isValidFileName(name) {
  if (!name || name.trim() === '') return false;
  return !/[\\/:*?"<>|]/.test(name);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

normalizeProjectFiles();

// Helper to get language from filename
function getLanguageFromFilename(filename) {
  const ext = getFileExtension(filename);
  switch (ext) {
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'txt':
      return 'plaintext';
    case 'xml':
    case 'svg':
      return 'xml';
    default:
      return 'plaintext';
  }
}

// Helper to get Lucide icon name from filename
function getIconForFilename(filename) {
  const ext = getFileExtension(filename);
  switch (ext) {
    case 'html':
    case 'htm':
      return 'code-2';
    case 'css':
      return 'palette';
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return 'braces';
    case 'json':
      return 'file-json';
    case 'md':
    case 'txt':
    case 'xml':
      return 'file-text';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
    case 'svg':
    case 'ico':
      return 'image';
    case 'woff':
    case 'woff2':
    case 'ttf':
      return 'type';
    case 'mp3':
      return 'music';
    case 'mp4':
    case 'webm':
      return 'film';
    default:
      return 'file-text';
  }
}
