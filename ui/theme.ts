const preference = window.matchMedia('(prefers-color-scheme: dark)');

function applySystemTheme() {
  const theme = preference.matches ? 'dark' : 'light';
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

applySystemTheme();
preference.addEventListener('change', applySystemTheme);

if (import.meta.hot) {
  import.meta.hot.dispose(() => preference.removeEventListener('change', applySystemTheme));
}
