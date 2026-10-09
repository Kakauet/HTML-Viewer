// Brief in-app help. Content is generated in the editor's language.
function initAboutPanel() {
  const panel = document.getElementById('about-panel');
  const overlay = document.getElementById('about-overlay');
  const closeBtn = document.getElementById('about-close-btn');
  const openButton = document.getElementById('btn-about');
  const body = document.getElementById('about-panel-body');
  if (!panel || !closeBtn || !openButton) return;
  let returnFocus = null;
  // The body scrolls; making it focusable lets keyboard users read it all.
  if (body) body.tabIndex = 0;

  function close() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    overlay?.classList.remove('active');
    // On compact layouts the opener lives in the (now closed) drawer.
    const target = returnFocus?.closest('[inert]') ? document.getElementById('btn-mobile-menu') : returnFocus;
    target?.focus({ preventScroll: true });
  }
  openButton.addEventListener('click', () => {
    returnFocus = openButton;
    panel.inert = false;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    overlay?.classList.add('active');
    if (body) body.scrollTop = 0;
    closeBtn.focus();
  });
  closeBtn.addEventListener('click', close);
  overlay?.addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (!panel.classList.contains('open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const stops = [closeBtn, body].filter(Boolean);
      const index = stops.indexOf(document.activeElement);
      const next = event.shiftKey ? index - 1 : index + 1;
      stops[(next + stops.length) % stops.length].focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', initAboutPanel);
