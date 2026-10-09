// Mobile Responsive Controls Logic
function initMobileControls() {
  if (mobileControlsInitialized) return;
  mobileControlsInitialized = true;
  const container = document.querySelector('.app-container');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const mobileMenuToggle = document.getElementById('btn-mobile-menu');
  const sidebarCloseBtn = document.getElementById('btn-sidebar-close');
  const focusModeButton = document.getElementById('btn-highlight-full');
  const tabButtons = document.querySelectorAll('.mobile-tab-btn');
  let mobileLayoutFrame = 0;
  let explorerAutoCollapsedForMobile = false;
  let wasMobile = window.innerWidth <= 768;

  // Set initial active tab on app container
  container.classList.add('active-tab-editor');

  function syncSidebarInteractivity() {
    if (!sidebar) return;
    const isDrawer = window.innerWidth <= COMPACT_LAYOUT_MAX_WIDTH;
    const isOpen = sidebar.classList.contains('open');

    if (isDrawer && !isOpen) {
      sidebar.setAttribute('aria-hidden', 'true');
      sidebar.inert = true;
      return;
    }

    sidebar.removeAttribute('aria-hidden');
    sidebar.inert = false;
  }

  function collapseMobileExplorer(force = false) {
    const isMobileNow = window.innerWidth <= 768;
    if (!isMobileNow || editorMode !== 'split' || isExplorerCollapsed) return;
    if (!force && wasMobile) return;

    const fileExplorer = document.getElementById('file-explorer');
    const btnToggleExplorer = document.getElementById('btn-toggle-explorer');
    isExplorerCollapsed = true;
    explorerAutoCollapsedForMobile = true;

    if (fileExplorer) {
      fileExplorer.classList.add('collapsed');
      fileExplorer.style.display = 'none';
    }
    if (btnToggleExplorer) {
      btnToggleExplorer.classList.remove('active');
    }
    if (editor && typeof editor.layout === 'function') {
      editor.layout();
    }
  }

  function restoreDesktopExplorer() {
    if (window.innerWidth <= 768 || editorMode !== 'split') return;

    if (!explorerAutoCollapsedForMobile) return;
    explorerAutoCollapsedForMobile = false;

    if (!isExplorerCollapsed) return;

    const fileExplorer = document.getElementById('file-explorer');
    const btnToggleExplorer = document.getElementById('btn-toggle-explorer');
    isExplorerCollapsed = false;

    if (fileExplorer) {
      fileExplorer.style.display = 'flex';
      fileExplorer.classList.remove('collapsed');
    }
    if (btnToggleExplorer) {
      btnToggleExplorer.classList.add('active');
    }
    if (editor && typeof editor.layout === 'function') {
      editor.layout();
    }
  }

  function disableMobileFocusMode() {
    if (window.innerWidth > COMPACT_LAYOUT_MAX_WIDTH || !container.classList.contains('fullscreen-editor')) return;

    container.classList.remove('fullscreen-editor');
    if (focusModeButton) {
      focusModeButton.classList.remove('active');
      focusModeButton.querySelector('i')?.setAttribute('data-lucide', 'maximize-2');
    }
    if (window.lucide?.createIcons) {
      window.lucide.createIcons();
    }
  }

  function syncMobileLayout(force = false) {
    syncSidebarInteractivity();
    disableMobileFocusMode();
    collapseMobileExplorer(force);
    restoreDesktopExplorer();
    wasMobile = window.innerWidth <= 768;
  }

  function queueMobileLayoutSync() {
    if (mobileLayoutFrame) return;
    mobileLayoutFrame = requestAnimationFrame(() => {
      mobileLayoutFrame = 0;
      syncMobileLayout();
    });
  }

  // Helper to close drawer
  function closeSidebar() {
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
    syncSidebarInteractivity();
    mobileMenuToggle?.setAttribute('aria-expanded', 'false');
  }

  // Helper to open drawer
  function openSidebar() {
    if (sidebar) sidebar.classList.add('open');
    if (overlay) overlay.classList.add('active');
    syncSidebarInteractivity();
    mobileMenuToggle?.setAttribute('aria-expanded', 'true');
    sidebarCloseBtn?.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !sidebar?.classList.contains('open')) return;
    if (window.innerWidth > COMPACT_LAYOUT_MAX_WIDTH) return;
    event.preventDefault();
    closeSidebar();
    mobileMenuToggle?.focus({ preventScroll: true });
  });

  // Sidebar toggle events
  if (mobileMenuToggle) {
    mobileMenuToggle.addEventListener('click', openSidebar);
  }
  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener('click', closeSidebar);
  }
  if (overlay) {
    overlay.addEventListener('click', closeSidebar);
  }

  mobileMenuToggle?.setAttribute('aria-expanded', 'false');
  tabButtons.forEach(btn => btn.setAttribute('aria-pressed', String(btn.classList.contains('active'))));

  // Tab switching events
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');

      const targetTab = btn.getAttribute('data-tab');
      if (targetTab === 'editor') {
        container.classList.remove('active-tab-preview');
        container.classList.add('active-tab-editor');
        collapseMobileExplorer();
        // Force Monaco editor layout update so it renders properly in full width
        setTimeout(() => {
          if (editor && typeof editor.layout === 'function') {
            editor.layout();
          }
        }, 150);
      } else {
        container.classList.remove('active-tab-editor');
        container.classList.add('active-tab-preview');
      }
    });
  });

  // Make sure actions close sidebar on mobile so the result is immediately visible
  const sidebarButtons = sidebar.querySelectorAll('button');
  sidebarButtons.forEach(btn => {
    // Exclude the close button itself
    if (btn !== sidebarCloseBtn) {
      btn.addEventListener('click', () => {
        // Only close while the sidebar is presented as a compact-layout drawer.
        if (window.innerWidth <= COMPACT_LAYOUT_MAX_WIDTH) {
          closeSidebar();
        }
      });
    }
  });

  const btnToggleExplorer = document.getElementById('btn-toggle-explorer');
  if (btnToggleExplorer) {
    btnToggleExplorer.addEventListener('click', () => {
      explorerAutoCollapsedForMobile = false;
    });
  }
  const activeFileSummary = document.getElementById('active-file-summary');
  if (activeFileSummary) {
    activeFileSummary.addEventListener('click', () => {
      explorerAutoCollapsedForMobile = false;
    });
  }

  // Treat the mobile file explorer as a drawer: blank/outside taps close it
  // before the gesture can reach and select code underneath.
  document.addEventListener('pointerdown', (event) => {
    if (window.innerWidth > 768 || editorMode !== 'split' || isExplorerCollapsed) return;

    const fileExplorer = document.getElementById('file-explorer');
    const target = event.target instanceof Element ? event.target : null;
    if (!fileExplorer || !target) return;

    const isExplorerAction = Boolean(target.closest(
      '.file-item, .folder-item, button, input, label, [role="button"]'
    ));
    if (fileExplorer.contains(target) && isExplorerAction) return;

    event.preventDefault();
    event.stopPropagation();
    toggleFileExplorer(false);
  }, true);

  window.addEventListener('resize', queueMobileLayoutSync);
  syncMobileLayout(true);
}

// Initialize State
function initState() {
  if (appStateInitialized) return;
  appStateInitialized = true;
  applyLocale();
  // Only two themes exist; ignore any other stored value.
  const savedTheme = readStoredValue('theme', 'dark') === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  const themeLabel = document.querySelector('#btn-theme span');

  if (themeLabel) {
    if (savedTheme === 'dark') {
      themeLabel.textContent = t('sidebar_mode_dark');
    } else {
      themeLabel.textContent = t('sidebar_mode_light');
    }
  }

  // Initialize editor mode selector
  initEditorModeSelector();

  // Initialize mobile responsive behaviors
  initMobileControls();

  // Initialize import/export modals and triggers
  initImportExportOptions();
  initAssetPreviewActions();

  // Initialize automatic drag & drop import
  initDragAndDrop();

  if (window.lucide?.createIcons) {
    window.lucide.createIcons();
  }
}

// Initialize on page load
initState();
