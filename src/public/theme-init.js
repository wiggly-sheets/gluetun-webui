/* Gluetun Web UI - theme-init.js: apply saved theme before first paint */
(function () {
  try {
    var saved = localStorage.getItem('gluetun_theme');
    var theme = 'dark';
    if (saved === 'light' || saved === 'dark') {
      theme = saved;
    } else if (saved === 'auto') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_) { /* storage unavailable: keep default dark */ }
})();