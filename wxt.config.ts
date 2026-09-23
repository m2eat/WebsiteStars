import { defineConfig } from 'wxt';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  vite: () => ({ plugins: [react(), tailwindcss()] }),
  manifest: {
    name: '__MSG_appName__',
    short_name: 'WebsiteStars',
    default_locale: 'en',
    homepage_url: 'https://github.com/m2eat/WebsiteStars',
    description: '__MSG_appDescription__',
    minimum_chrome_version: '120',
    permissions: ['storage', 'activeTab', 'scripting', 'contextMenus', 'sidePanel', 'alarms', 'offscreen'],
    host_permissions: ['http://*/*', 'https://*/*'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*'],
    action: { default_title: '__MSG_openSidebar__' },
    commands: { 'open-library': { suggested_key: { default: 'Alt+Shift+S' }, description: '__MSG_openLibrary__' }, 'save-page': { suggested_key: { default: 'Alt+Shift+D' }, description: '__MSG_savePage__' } },
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
  },
});
