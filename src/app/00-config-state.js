// Modern HTML Online Viewer Application logic

// Matches the CSS breakpoint where the fixed sidebar and both panel minima stop fitting.
const COMPACT_LAYOUT_MAX_WIDTH = 1152;

function readStoredValue(key, fallbackValue = null) {
  try {
    const value = window.localStorage?.getItem(key);
    return value === null ? fallbackValue : value;
  } catch {
    return fallbackValue;
  }
}

function writeStoredValue(key, value) {
  try {
    window.localStorage?.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

function getOrCreatePreviewSessionId() {
  const storageKey = 'html-viewer-preview-session-id';
  try {
    const existing = window.sessionStorage?.getItem(storageKey) || '';
    if (/^session-[a-z0-9-]+$/i.test(existing)) return existing;
    const randomPart = window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    const sessionId = `session-${Date.now().toString(36)}-${randomPart}`;
    window.sessionStorage?.setItem(storageKey, sessionId);
    return sessionId;
  } catch {
    return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

// --- Language & Translation System ---
// The generated HTML determines the editor language.
// Language links navigate between the complete / and /es/ experiences.
let currentLocale = document.documentElement.lang === 'es' ? 'es' : 'en';

const TRANSLATIONS = {
  es: {
    "sidebar_preview": "Página completa",
    "sidebar_focus": "Modo enfoque",
    "sidebar_import": "Importar proyecto",
    "sidebar_export": "Exportar HTML",
    "sidebar_sample": "Cargar ejemplo",
    "sidebar_clear": "Limpiar todo",
    "sidebar_mode_dark": "Modo oscuro",
    "sidebar_mode_light": "Modo claro",
    "cat_view": "Vista",
    "cat_file": "Archivo",
    "cat_file_unified": "Documento",
    "cat_file_split": "Proyecto",
    "sidebar_import_unified": "Importar HTML",
    "sidebar_import_split": "Importar proyecto",
    "sidebar_export_unified": "Descargar HTML",
    "sidebar_export_split": "Exportar proyecto",
    "cat_actions": "Acciones",
    "mobile_code": "Código",
    "mobile_view": "Vista",
    "mobile_open_menu": "Abrir menú",
    "mobile_close_menu": "Cerrar menú",
    "toggle_explorer_title": "Mostrar/ocultar menú de archivos",
    "no_file_selected": "Ningún archivo seleccionado",
    "tooltip_undo": "Deshacer (Ctrl+Z)",
    "tooltip_redo": "Rehacer (Ctrl+Y)",
    "label_undo": "Deshacer",
    "label_redo": "Rehacer",
    "mode_unified": "Simple",
    "mode_split": "Archivos",
    "mode_unified_title": "Archivo único",
    "mode_split_title": "Archivos separados",
    "choose_file": "Elegir archivo",
    "upload_files": "Subir archivos",
    "new_file": "Nuevo archivo",
    "new_folder": "Nueva carpeta",
    "rename": "Renombrar",
    "delete": "Eliminar",
    "rename_folder": "Renombrar carpeta",
    "rename_file": "Renombrar archivo",
    "delete_folder": "Eliminar carpeta",
    "delete_file": "Eliminar archivo",
    "open_preview": "Abrir en vista previa",
    "reload_preview": "Volver a cargar este HTML en la vista previa",
    "choose_file_selector_title": "Abre el selector de archivos para elegir uno",
    "change_file_aria": "Cambiar archivo. Actual: {name}",
    "placeholder_html": "Escribe aquí tu HTML",
    "placeholder_css": "Escribe aquí tu CSS",
    "placeholder_js": "Escribe aquí tu JavaScript",
    "placeholder_json": "Escribe aquí tu JSON",
    "placeholder_md": "Escribe aquí tu Markdown",
    "placeholder_code": "Escribe aquí tu código",
    "placeholder_open_file": "Abre un archivo para comenzar a editar",
    "btn_path": "Ruta",
    "btn_img": "img",
    "btn_css": "CSS",
    "title_path": "Copiar ruta",
    "title_img": "Copiar etiqueta de imagen",
    "title_css": "Copiar url CSS",
    "emulator_reload": "Recargar previsualización",
    "emulator_home": "Volver a la página inicial",
    "emulator_desktop": "Escritorio",
    "emulator_tablet": "Tablet",
    "emulator_mobile": "Móvil",
    "emulator_desktop_title": "Vista de escritorio",
    "emulator_tablet_title": "Vista de tablet",
    "emulator_mobile_title": "Vista móvil",
    "drag_title_import": "Suelta para importar archivos",
    "drag_desc_import": "Puedes soltar en cualquier zona de la aplicación",
    "drag_title_add": "Suelta aquí para añadir al proyecto",
    "drag_desc_add": "Los archivos se conservarán dentro del proyecto actual",
    "drag_title_project": "Suelta para importar proyecto",
    "drag_title_html": "Suelta para abrir HTML",
    "drag_desc_files": "El archivo se añadirá al proyecto automáticamente",
    "drag_desc_main": "La importación se abrirá como contenido principal",
    "export_title": "Exportar proyecto",
    "export_subtitle": "Elige el formato de salida para guardar tu código",
    "export_local_title": "Carpeta local",
    "export_local_desc": "Guarda los archivos directamente en una carpeta local (requiere soporte de navegador)",
    "export_local_unsupported": "No compatible",
    "export_zip_title": "Archivo ZIP",
    "export_zip_desc": "Empaqueta todos los archivos virtuales en un archivo comprimido .zip descargable",
    "export_unified_title": "Exportar como HTML único",
    "export_unified_desc": "Compila y une todos los archivos en un único HTML listo para producción",
    "toast_offline_mode": "Modo sin conexión activado (editor básico)",
    "toast_popup_blocked": "El navegador bloqueó la ventana emergente",
    "toast_project_opened_virtual": "Proyecto abierto a página completa",
    "toast_full_page_opened": "Visualización a página completa abierta",
    "toast_page_open_error": "Error al abrir la página",
    "toast_sample_loaded": "Código de ejemplo cargado",
    "toast_editor_cleared": "Editor vaciado",
    "toast_format_not_supported": "Formato no soportado. Selecciona un archivo .html o .zip",
    "toast_files_added": "{count} archivo(s) añadidos",
    "toast_file_exported_as": "Archivo exportado como {name}",
    "toast_export_error": "Error al exportar el archivo",
    "toast_jszip_not_loaded": "No se pudo cargar el módulo ZIP. Recarga la página e inténtalo de nuevo.",
    "toast_project_exported_zip": "Proyecto exportado como ZIP: {name}",
    "toast_zip_generate_error": "Error al generar el archivo ZIP",
    "toast_local_export_unsupported": "Tu navegador no soporta la exportación a carpeta local.",
    "toast_local_export_success": "Proyecto exportado con éxito a la carpeta local",
    "toast_export_cancelled": "Exportación cancelada",
    "toast_folder_export_error": "Error al exportar a carpeta: {message}",
    "toast_html_imported": "Archivo HTML importado: {name}",
    "toast_html_read_error": "Error al leer el archivo HTML",
    "toast_zip_no_valid_files": "No se encontraron archivos válidos dentro del ZIP",
    "toast_zip_import_error": "Error al importar el archivo ZIP",
    "toast_no_valid_import": "No se encontraron archivos válidos para importar",
    "toast_file_added_to_project": "archivo añadido al proyecto",
    "toast_files_added_to_project": "archivos añadidos al proyecto",
    "toast_folder_imported": "Carpeta importada con éxito: {count} archivos/carpetas cargados",
    "toast_folder_import_error": "Error al importar la carpeta soltada",
    "toast_unified_html_exported": "HTML unificado exportado como {name}",
    "toast_unified_export_error": "Error al exportar HTML unificado",
    "toast_clipboard_error": "No se pudo copiar al portapapeles",
    "toast_path_copied": "Ruta copiada",
    "toast_img_tag_copied": "Etiqueta img copiada",
    "toast_css_url_copied": "URL CSS copiada",
    "toast_move_outside_root_error": "No se pueden mover elementos fuera de la carpeta madre",
    "toast_file_exists_in_folder": "Ya existe un archivo con ese nombre en esa carpeta",
    "toast_move_inside_self_error": "No se puede mover una carpeta dentro de sí misma",
    "toast_folder_exists_in_location": "Ya existe una carpeta con ese nombre en esa ubicación",
    "toast_files_updated_paths": "{count} archivo(s) actualizados con rutas nuevas",
    "toast_files_added_to_root": "{count} archivo(s) añadidos a la raíz",
    "toast_files_added_to_folder": "{count} archivo(s) añadidos a {name}",
    "toast_folder_name_invalid": "El nombre de la carpeta no puede contener \ / : * ? \" < > |",
    "toast_folder_renamed": "Carpeta renombrada a {name}",
    "toast_references_updated": "{count} referencia(s) actualizadas",
    "toast_cannot_delete_folder_preview": "No se puede eliminar la carpeta porque contiene el HTML abierto en la vista previa",
    "toast_folder_deleted": "Carpeta \"{name}\" eliminada",
    "toast_cannot_delete_file_preview": "No se puede eliminar el HTML abierto en la vista previa",
    "toast_file_deleted": "Archivo eliminado: {name}",
    "toast_file_name_invalid": "El nombre del archivo no puede contener \ / : * ? \" < > |",
    "toast_file_renamed": "Archivo renombrado a {name}",
    "default_folder_name": "proyecto",
    "default_file_name": "archivo",
    "imported_project_name": "proyecto-importado",
    "sidebar_about": "Ayuda",
    "about_title": "Ayuda",
    "explorer_title": "Explorador",
    "close_dialog": "Cerrar",
    "resize_panels": "Cambiar el tamaño de los paneles",
    "toast_undo": "Deshacer",
    "preview_ready": "Listo",
    "preview_empty_title": "La vista previa aparecerá aquí",
    "preview_empty_hint": "Escribe HTML en el editor, carga el ejemplo o arrastra un archivo .html o .zip.",
    "zoom_in": "Acercar",
    "zoom_out": "Alejar",
    "zoom_reset": "Restablecer zoom",
    "console_title": "Diagnóstico",
    "console_open": "Abrir consola de diagnóstico",
    "console_close": "Cerrar consola",
    "console_clear": "Limpiar",
    "console_resize": "Cambiar la altura de la consola",
    "console_filters": "Filtrar diagnósticos",
    "console_filter_all": "Todos",
    "console_filter_resource": "Recursos",
    "console_filter_route": "Rutas",
    "console_filter_cors": "CORS/red",
    "console_none": "Sin problemas",
    "console_count_one": "1 problema",
    "console_count_other": "{count} problemas",
    "console_button_title": "Consola de diagnóstico: {summary}",
    "console_empty": "No se han detectado problemas.",
    "console_empty_filtered": "No hay problemas de este tipo.",
    "diag_error": "JavaScript",
    "diag_warning": "Aviso",
    "diag_resource": "Recurso",
    "diag_route": "Ruta",
    "diag_cors": "CORS/red",
    "diag_generic": "Diagnóstico",
    "diag_hint_cors": "El servidor remoto puede estar bloqueando la petición. Revisa Access-Control-Allow-Origin y la URL.",
    "diag_hint_route": "Comprueba que la ruta exista y que respete mayúsculas, carpetas y extensión.",
    "diag_hint_resource": "Comprueba la ruta del archivo y que el recurso esté incluido en el proyecto.",
    "diag_resource_failed": "No se pudo cargar el recurso",
    "diag_js_error": "Error de JavaScript",
    "diag_unhandled_rejection": "Promesa rechazada sin gestionar",
    "diag_service_worker_disabled": "La vista previa no ejecuta service workers del proyecto.",
    "preview_viewing": "Viendo",
    "full_page_loading": "Preparando la página…",
    "full_page_expired": "Esta vista ya no está disponible. Ábrela de nuevo desde el editor."
  },
  en: {
    "sidebar_preview": "Full Page",
    "sidebar_focus": "Focus Mode",
    "sidebar_import": "Import Project",
    "sidebar_export": "Export HTML",
    "sidebar_sample": "Load Example",
    "sidebar_clear": "Clear All",
    "sidebar_mode_dark": "Dark Mode",
    "sidebar_mode_light": "Light Mode",
    "cat_view": "View",
    "cat_file": "File",
    "cat_file_unified": "Document",
    "cat_file_split": "Project",
    "sidebar_import_unified": "Import HTML",
    "sidebar_import_split": "Import Project",
    "sidebar_export_unified": "Download HTML",
    "sidebar_export_split": "Export Project",
    "cat_actions": "Actions",
    "mobile_code": "Code",
    "mobile_view": "Preview",
    "mobile_open_menu": "Open menu",
    "mobile_close_menu": "Close menu",
    "toggle_explorer_title": "Toggle file explorer",
    "no_file_selected": "No file selected",
    "tooltip_undo": "Undo (Ctrl+Z)",
    "tooltip_redo": "Redo (Ctrl+Y)",
    "label_undo": "Undo",
    "label_redo": "Redo",
    "mode_unified": "Simple",
    "mode_split": "Files",
    "mode_unified_title": "Single file",
    "mode_split_title": "Separate files",
    "choose_file": "Choose file",
    "upload_files": "Upload files",
    "new_file": "New file",
    "new_folder": "New folder",
    "rename": "Rename",
    "delete": "Delete",
    "rename_folder": "Rename folder",
    "rename_file": "Rename file",
    "delete_folder": "Delete folder",
    "delete_file": "Delete file",
    "open_preview": "Open in preview",
    "reload_preview": "Reload this HTML in preview",
    "choose_file_selector_title": "Open the file chooser to select one",
    "change_file_aria": "Change file. Current: {name}",
    "placeholder_html": "Write your HTML here",
    "placeholder_css": "Write your CSS here",
    "placeholder_js": "Write your JavaScript here",
    "placeholder_json": "Write your JSON here",
    "placeholder_md": "Write your Markdown here",
    "placeholder_code": "Write your code here",
    "placeholder_open_file": "Open a file to start editing",
    "btn_path": "Path",
    "btn_img": "img",
    "btn_css": "CSS",
    "title_path": "Copy path",
    "title_img": "Copy image tag",
    "title_css": "Copy CSS URL",
    "emulator_reload": "Reload preview",
    "emulator_home": "Return to the home page",
    "emulator_desktop": "Desktop",
    "emulator_tablet": "Tablet",
    "emulator_mobile": "Mobile",
    "emulator_desktop_title": "Desktop view",
    "emulator_tablet_title": "Tablet view",
    "emulator_mobile_title": "Mobile view",
    "drag_title_import": "Drop to import files",
    "drag_desc_import": "You can drop anywhere on the application",
    "drag_title_add": "Drop here to add to the project",
    "drag_desc_add": "Files will be kept inside the current project",
    "drag_title_project": "Drop to import project",
    "drag_title_html": "Drop to open HTML",
    "drag_desc_files": "The file will be added to the project automatically",
    "drag_desc_main": "The import will be opened as main content",
    "export_title": "Export Project",
    "export_subtitle": "Choose the output format to save your code",
    "export_local_title": "Local Folder",
    "export_local_desc": "Save files directly to a local folder (requires browser support)",
    "export_local_unsupported": "Unsupported",
    "export_zip_title": "ZIP File",
    "export_zip_desc": "Package all virtual files into a downloadable compressed .zip file",
    "export_unified_title": "Export as single HTML",
    "export_unified_desc": "Compile and merge all files into a single HTML ready for production",
    "toast_offline_mode": "Offline mode activated (basic editor)",
    "toast_popup_blocked": "The browser blocked the pop-up window",
    "toast_project_opened_virtual": "Project opened in full page",
    "toast_full_page_opened": "Full page preview opened",
    "toast_page_open_error": "Error opening page",
    "toast_sample_loaded": "Sample code loaded",
    "toast_editor_cleared": "Editor cleared",
    "toast_format_not_supported": "Format not supported. Select a .html or .zip file",
    "toast_files_added": "{count} file(s) added",
    "toast_file_exported_as": "File exported as {name}",
    "toast_export_error": "Error exporting file",
    "toast_jszip_not_loaded": "The ZIP module could not be loaded. Reload the page and try again.",
    "toast_project_exported_zip": "Project exported as ZIP: {name}",
    "toast_zip_generate_error": "Error generating ZIP file",
    "toast_local_export_unsupported": "Your browser does not support local folder export.",
    "toast_local_export_success": "Project successfully exported to local folder",
    "toast_export_cancelled": "Export cancelled",
    "toast_folder_export_error": "Error exporting to folder: {message}",
    "toast_html_imported": "HTML file imported: {name}",
    "toast_html_read_error": "Error reading HTML file",
    "toast_zip_no_valid_files": "No valid files found inside the ZIP",
    "toast_zip_import_error": "Error importing ZIP file",
    "toast_no_valid_import": "No valid files found to import",
    "toast_file_added_to_project": "file added to project",
    "toast_files_added_to_project": "files added to project",
    "toast_folder_imported": "Folder successfully imported: {count} files/folders loaded",
    "toast_folder_import_error": "Error importing dropped folder",
    "toast_unified_html_exported": "Unified HTML exported as {name}",
    "toast_unified_export_error": "Error exporting unified HTML",
    "toast_clipboard_error": "Could not copy to clipboard",
    "toast_path_copied": "Path copied",
    "toast_img_tag_copied": "img tag copied",
    "toast_css_url_copied": "CSS URL copied",
    "toast_move_outside_root_error": "Cannot move elements outside the root folder",
    "toast_file_exists_in_folder": "A file with that name already exists in that folder",
    "toast_move_inside_self_error": "Cannot move a folder inside itself",
    "toast_folder_exists_in_location": "A folder with that name already exists in that location",
    "toast_files_updated_paths": "{count} file(s) updated with new paths",
    "toast_files_added_to_root": "{count} file(s) added to root",
    "toast_files_added_to_folder": "{count} file(s) added to {name}",
    "toast_folder_name_invalid": "Folder name cannot contain \ / : * ? \" < > |",
    "toast_folder_renamed": "Folder renamed to {name}",
    "toast_references_updated": "{count} reference(s) updated",
    "toast_cannot_delete_folder_preview": "Cannot delete the folder because it contains the HTML open in the preview",
    "toast_folder_deleted": "Folder \"{name}\" deleted",
    "toast_cannot_delete_file_preview": "Cannot delete the HTML open in the preview",
    "toast_file_deleted": "File deleted: {name}",
    "toast_file_name_invalid": "File name cannot contain \ / : * ? \" < > |",
    "toast_file_renamed": "File renamed to {name}",
    "default_folder_name": "project",
    "default_file_name": "file",
    "imported_project_name": "imported-project",
    "sidebar_about": "Help",
    "about_title": "Help",
    "explorer_title": "Explorer",
    "close_dialog": "Close",
    "resize_panels": "Resize panels",
    "toast_undo": "Undo",
    "preview_ready": "Ready",
    "preview_empty_title": "Your preview will appear here",
    "preview_empty_hint": "Write HTML in the editor, load the example or drop an .html or .zip file.",
    "zoom_in": "Zoom in",
    "zoom_out": "Zoom out",
    "zoom_reset": "Reset zoom",
    "console_title": "Diagnostics",
    "console_open": "Open diagnostics console",
    "console_close": "Close console",
    "console_clear": "Clear",
    "console_resize": "Resize console",
    "console_filters": "Filter diagnostics",
    "console_filter_all": "All",
    "console_filter_resource": "Resources",
    "console_filter_route": "Routes",
    "console_filter_cors": "CORS/network",
    "console_none": "No issues",
    "console_count_one": "1 issue",
    "console_count_other": "{count} issues",
    "console_button_title": "Diagnostics console: {summary}",
    "console_empty": "No issues detected.",
    "console_empty_filtered": "No issues of this type.",
    "diag_error": "JavaScript",
    "diag_warning": "Warning",
    "diag_resource": "Resource",
    "diag_route": "Route",
    "diag_cors": "CORS/network",
    "diag_generic": "Diagnostic",
    "diag_hint_cors": "The remote server may be blocking the request. Check Access-Control-Allow-Origin and the URL.",
    "diag_hint_route": "Check that the route exists and matches letter case, folders and extension.",
    "diag_hint_resource": "Check the file path and that the resource is included in the project.",
    "diag_resource_failed": "The resource could not be loaded",
    "diag_js_error": "JavaScript error",
    "diag_unhandled_rejection": "Unhandled promise rejection",
    "diag_service_worker_disabled": "The preview does not run the project's service workers.",
    "preview_viewing": "Viewing",
    "full_page_loading": "Preparing the page…",
    "full_page_expired": "This view is no longer available. Open it again from the editor."
  }
};

function t(key, replacements = {}) {
  const dict = TRANSLATIONS[currentLocale] || TRANSLATIONS['en'];
  let text = dict[key] || TRANSLATIONS['en'][key] || key;
  for (const [placeholder, value] of Object.entries(replacements)) {
    text = text.replace(new RegExp(`\\{${placeholder}\\}`, 'g'), value);
  }
  return text;
}

function applyLocale() {
  document.documentElement.setAttribute('lang', currentLocale);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.setAttribute('title', t(key));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.setAttribute('placeholder', t(key));
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria-label');
    el.setAttribute('aria-label', t(key));
  });
  updateSidebarTexts();
}

function updateSidebarTexts() {
  const catFileEl = document.querySelector('[data-i18n="cat_file"]');
  const importTextEl = document.querySelector('[data-i18n="sidebar_import"]');
  const exportTextEl = document.querySelector('[data-i18n="sidebar_export"]');

  if (catFileEl) {
    catFileEl.textContent = t(editorMode === 'unified' ? 'cat_file_unified' : 'cat_file_split');
  }
  if (importTextEl) {
    importTextEl.textContent = t(editorMode === 'unified' ? 'sidebar_import_unified' : 'sidebar_import_split');
  }
  if (exportTextEl) {
    exportTextEl.textContent = t(editorMode === 'unified' ? 'sidebar_export_unified' : 'sidebar_export_split');
  }
}

const INITIAL_EDITOR_CODE = '';
const EDITOR_PLACEHOLDER_TEXT = currentLocale === 'es' ? 'Escribe aquí tu HTML' : 'Write your HTML here';

const DEFAULT_SAMPLE_CODE_ES = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Una nota sobre el silencio</title>
</head>
<body style="background:#f4f1ea; margin:0; padding:80px 24px; font-family:Georgia, 'Times New Roman', serif; color:#2b2722;">

  <article style="max-width:560px; margin:0 auto;">

    <p style="font-family:Helvetica, Arial, sans-serif; font-size:12px; letter-spacing:3px; text-transform:uppercase; color:#9a8f7d; margin:0 0 28px;">
      Cuaderno &mdash; primera entrada
    </p>

    <h1 style="font-size:34px; line-height:1.25; margin:0 0 24px; font-weight:normal;">
      El silencio también tiene forma
    </h1>

    <p style="font-size:17px; line-height:1.8; margin:0 0 20px;">
      No es la ausencia de sonido, sino el espacio que queda cuando algo termina de decirse.
      Entre dos frases hay siempre una pausa más honesta que las palabras que la rodean.
    </p>

    <p style="font-size:17px; line-height:1.8; margin:0 0 20px;">
      Escribir bien no es llenar la página. Es saber cuánto dejar fuera de ella.
    </p>

    <hr style="border:none; border-top:1px solid #ddd6c7; margin:36px 0;">

    <p style="font-family:Helvetica, Arial, sans-serif; font-size:13px; letter-spacing:1px; color:#9a8f7d; margin:0;">
      &mdash; A.
    </p>

  </article>

</body>
</html>`;

const DEFAULT_SAMPLE_CODE_EN = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>A note on silence</title>
</head>
<body style="background:#f4f1ea; margin:0; padding:80px 24px; font-family:Georgia, 'Times New Roman', serif; color:#2b2722;">

  <article style="max-width:560px; margin:0 auto;">

    <p style="font-family:Helvetica, Arial, sans-serif; font-size:12px; letter-spacing:3px; text-transform:uppercase; color:#9a8f7d; margin:0 0 28px;">
      Notebook &mdash; first entry
    </p>

    <h1 style="font-size:34px; line-height:1.25; margin:0 0 24px; font-weight:normal;">
      Silence also has a shape
    </h1>

    <p style="font-size:17px; line-height:1.8; margin:0 0 20px;">
      It is not the absence of sound, but the space that remains when something finished being said.
      Between two sentences there is always a pause more honest than the words that surround it.
    </p>

    <p style="font-size:17px; line-height:1.8; margin:0 0 20px;">
      Writing well is not about filling the page. It is knowing how much to leave out of it.
    </p>

    <hr style="border:none; border-top:1px solid #ddd6c7; margin:36px 0;">

    <p style="font-family:Helvetica, Arial, sans-serif; font-size:13px; letter-spacing:1px; color:#9a8f7d; margin:0;">
      &mdash; A.
    </p>

  </article>

</body>
</html>`;

const DEFAULT_SAMPLE_CODE = currentLocale === 'es' ? DEFAULT_SAMPLE_CODE_ES : DEFAULT_SAMPLE_CODE_EN;

// An unchanged re-render keeps the same visible state as a completed load.
const PREVIEW_IDLE_LABEL = currentLocale === 'es' ? 'Listo' : 'Ready';
const PREVIEW_RENDERING_LABEL = currentLocale === 'es' ? 'Renderizando' : 'Rendering';
const PREVIEW_READY_LABEL = currentLocale === 'es' ? 'Listo' : 'Ready';
const PREVIEW_NOT_FOUND_LABEL = currentLocale === 'es' ? 'No encontrado' : 'Not found';
const MONACO_VERSION = '0.57.0';
const JSZIP_VERSION = '3.10.2';
// Resolve lazy libraries from the bundle, not the localized document URL.
// This also preserves Simple mode when index.html is opened via file://.
const APP_ROOT_URL = new URL('.', document.currentScript?.src || document.baseURI).href;
const CONFIGURED_PREVIEW_ORIGIN = document.querySelector('meta[name="html-viewer-preview-origin"]')?.content || '';
let PREVIEW_ROOT_URL = CONFIGURED_PREVIEW_ORIGIN
  ? new URL(new URL(APP_ROOT_URL).pathname, CONFIGURED_PREVIEW_ORIGIN).href : APP_ROOT_URL;
let PREVIEW_ORIGIN = new URL(PREVIEW_ROOT_URL).origin;
let IS_REMOTE_PREVIEW = PREVIEW_ORIGIN !== new URL(APP_ROOT_URL).origin;
const MONACO_BASE_PATH = new URL(`assets/vendor/monaco-editor/${MONACO_VERSION}/browser`, APP_ROOT_URL).href;
const MONACO_LOADER_PATH = `${MONACO_BASE_PATH}/editor.main.js`;
const MONACO_LOAD_TIMEOUT_MS = 12000;
const MONACO_RETRY_DELAY_MS = 1200;
const MONACO_MAX_AUTOMATIC_RETRIES = 1;
const EDITOR_DEFAULT_FONT_SIZE = 13;
const EDITOR_MIN_FONT_SIZE = 10;
const EDITOR_MAX_FONT_SIZE = 24;
let EDITOR_CONTENT_LEFT = 68;
function updateEditorContentLeft() {
  EDITOR_CONTENT_LEFT = window.innerWidth <= 768 ? 44 : 68;
}
updateEditorContentLeft();
window.addEventListener('resize', updateEditorContentLeft);
const HISTORY_DEBOUNCE_MS = 250;
const MAX_TOASTS = 3;
const PROJECT_PREVIEW_PREFIX = '__html_viewer_project__';
// Full-page host: shows a preview in a sandboxed frame of its own window.
const PREVIEW_HOST_PAGE = 'preview.html';
// Capabilities granted to previewed pages. `allow-same-origin` is added only
// for Files, whose pages must be served by the preview service worker.
const PREVIEW_SANDBOX_TOKENS = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation';
const PROJECT_PREVIEW_VERSION_PARAM = '__html_viewer_version';
const PROJECT_PREVIEW_SW_VERSION = '20260811-1';
const PROJECT_PREVIEW_SW_URL = new URL(`preview-sw.js?v=${PROJECT_PREVIEW_SW_VERSION}`, PREVIEW_ROOT_URL).href;
const PROJECT_PREVIEW_SW_SCOPE = new URL(`${PROJECT_PREVIEW_PREFIX}/`, APP_ROOT_URL).pathname;
const PROJECT_PREVIEW_SW_READY_TIMEOUT_MS = 1800;
const PROJECT_PREVIEW_MESSAGE_TIMEOUT_MS = 8000;
const PROJECT_PREVIEW_DEBOUNCE_MIN_MS = 90;
const PROJECT_PREVIEW_DEBOUNCE_MAX_MS = 650;
const EMPTY_PROJECT_PREVIEW_MESSAGE = currentLocale === 'es' ? 'No hay archivos en el proyecto' : 'There are no files in the project';

const fallbackTextarea = document.getElementById('fallback-textarea');
const fallbackLineNumbers = document.getElementById('fallback-line-numbers');
const fallbackCurrentLine = document.getElementById('fallback-current-line');
const filenameInput = document.getElementById('editor-filename');
const previewIframe = document.getElementById('preview-iframe');
const editorPlaceholder = document.getElementById('editor-placeholder');
const previewStatus = document.getElementById('preview-status');

// Toast Notification Helper. An optional action (e.g. Undo) keeps the toast
// visible a little longer and dismisses it once used.
function showToast(message, type = 'success', { action = null } = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const activeToasts = container.querySelectorAll('.toast:not(.hide)');

  if (activeToasts.length >= MAX_TOASTS) {
    const oldest = activeToasts[0];
    oldest.classList.add('hide');
    setTimeout(() => {
      oldest.remove();
    }, 300);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const iconName = type === 'success' ? 'check-circle' : (type === 'error' ? 'alert-circle' : 'info');
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', iconName);
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(icon, text);

  let hideTimeout = 0;
  const dismiss = () => {
    clearTimeout(hideTimeout);
    if (!toast.parentNode || toast.classList.contains('hide')) return;
    toast.classList.add('hide');
    setTimeout(() => {
      toast.remove();
    }, 350);
  };

  if (action?.label && typeof action.onClick === 'function') {
    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'toast-action';
    actionButton.textContent = action.label;
    actionButton.addEventListener('click', () => {
      dismiss();
      action.onClick();
    }, { once: true });
    toast.appendChild(actionButton);
  }

  container.appendChild(toast);
  if (window.lucide) {
    lucide.createIcons();
  }

  // Keep the toast while the pointer rests on it, so actions stay reachable.
  const duration = action ? 6000 : 3000;
  const scheduleHide = () => {
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(dismiss, duration);
  };
  toast.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
  toast.addEventListener('mouseleave', scheduleHide);
  scheduleHide();
}

// Shows a confirmation toast whose action reverts the step that was just
// recorded. Later edits make the action a no-op instead of undoing them.
function showUndoableToast(message, type = 'success') {
  const expectedState = undoStack[undoStack.length - 1];
  showToast(message, type, {
    action: {
      label: t('toast_undo'),
      onClick: () => {
        if (expectedState && undoStack[undoStack.length - 1] === expectedState) triggerUndo();
      }
    }
  });
}

// Download a Blob without revoking its URL before slower browsers start the
// transfer (Firefox/Safari can cancel a download whose URL is revoked at once).
function downloadBlob(blob, filename) {
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000);
}

// App State
let editor;
let isResizing = false;
let previewFrameRequest = 0;
const previewLifecycle = {
  generation: 0,
  committedGeneration: 0,
  scheduledRequest: null,
  expectedNavigation: null,
  initialized: false,
  phase: 'idle',
  mode: 'srcdoc',
  activeDiagnosticToken: '',
  projectPath: '',
  projectSearch: '',
  projectHash: '',
  homeNavigationPending: false,
  isAwayFromHome: false,
  sessionGeneration: 0
};
let lastPreviewCode = '';
let renderingTimeoutId = null;
let monacoLoaded = false;
let editorFontSize = EDITOR_DEFAULT_FONT_SIZE;

let projectPreviewSessionId = getOrCreatePreviewSessionId();
let projectPreviewVersion = 0;
let projectPreviewIssuedVersion = 0;
let projectPreviewLastUrl = '';
let projectPreviewNeedsFullSync = true;
let projectPreviewKnownPaths = new Set();
let projectPreviewDirtyPaths = new Map();
let projectPreviewDirtySerial = 0;
let projectPreviewFullDirtySerial = 0;
let projectPreviewSyncQueue = Promise.resolve();
let projectPreviewMissingPath = '';
let projectPreviewNotifiedMissingPath = '';
let projectPreviewSiteRoot = '';
let previewShouldRestoreEditorFocus = false;
let previewBlockFocusForCurrentRender = false;
let projectPreviewLastBlockFocus = null;
let previewLastUserInteractionAt = 0;
let appStateInitialized = false;
let mobileControlsInitialized = false;

// Unified / Separated mode state variables
let editorMode = 'unified'; // 'unified' or 'split'

// Monaco Models
let unifiedModel;
const fileModels = {}; // fileId -> monaco.editor.ITextModel

const TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonld', 'geojson', 'gltf', 'map', 'webmanifest', 'md', 'txt', 'csv', 'yaml', 'yml', 'xml', 'rss', 'atom', 'vtt', 'svg'
]);
const IMAGE_EXTENSIONS = new Set(['png', 'apng', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif', 'bmp']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);
const FONT_EXTENSIONS = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot']);

let fileIdCounter = 4;
let nextFileOrder = 1;
let activeAssetPreviewUrl = '';
let activeImageZoomController = null;
let internalDragState = null;
let activeExplorerDropElement = null;
let pendingAssetTargetPath = '';
let lucideRenderFrame = 0;
let pendingHtmlOpenClick = null;


function scheduleLucideIcons() {
  if (!window.lucide || lucideRenderFrame) return;
  lucideRenderFrame = requestAnimationFrame(() => {
    lucideRenderFrame = 0;
    if (window.lucide) {
      lucide.createIcons();
    }
  });
}
let activeFileId = '1';
let openFileIds = ['1', '2', '3'];
let isExplorerCollapsed = false;
requestAnimationFrame(() => {
  isExplorerCollapsed = window.innerWidth <= 768;
});
let selectedEntryFileId = '1';
let cameFromSplitMode = false;

// Global history state for Undo/Redo
const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 50;
let isRestoringHistory = false;
let typingSessionActive = false;
let typingDebounceTimeout = null;
// These values are deliberately kept outside Monaco.  They let the editor
// hand off a stable document to history while Monaco/fallback events are
// delivering the already-mutated value.
let unifiedLastKnownContent = '';
let fallbackLastKnownValue = '';
let historyRestorePromise = Promise.resolve();
let historyRestoreInProgress = false;

// A replacement import is transactional.  Readers may finish out of order,
// but only the latest intention is allowed to commit.
let importGeneration = 0;
let importCommitInProgress = false;
let projectIdentity = 0;

