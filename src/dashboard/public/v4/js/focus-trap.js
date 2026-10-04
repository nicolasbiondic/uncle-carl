// ── focus-trap.js — tiny dependency-free modal focus trap + restore.
// Call on open with the dialog's root element; call the returned release()
// on close (removes the Tab handler and restores focus to the trigger).
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function trapFocus(rootEl) {
  const prev = document.activeElement;
  const focusables = () => [...rootEl.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  (focusables()[0] || rootEl).focus();
  function onKeydown(e) {
    if (e.key !== "Tab") return;
    const els = focusables();
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  rootEl.addEventListener("keydown", onKeydown);
  return function release() {
    rootEl.removeEventListener("keydown", onKeydown);
    if (prev && typeof prev.focus === "function" && document.body.contains(prev)) prev.focus();
  };
}
