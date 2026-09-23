import '../../ui/theme';
import { I18nProvider } from 'react-aria';
import { getLocale, initializePage } from '../../lib/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryApp } from '../../ui/LibraryApp';
import { AppBoundary } from '../../ui/components';
import '../../ui/styles.css';

initializePage('我的资料库');

createRoot(document.getElementById('root')!).render(
  <StrictMode><I18nProvider locale={getLocale()}><AppBoundary><LibraryApp mode="library" /></AppBoundary></I18nProvider></StrictMode>,
);
