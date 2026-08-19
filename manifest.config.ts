import { defineManifest } from '@crxjs/vite-plugin';
import packageJson from './package.json';

const { version } = packageJson;

// Split from "x.y.z-beta.1" to "x.y.z.1"
const [major, minor, patch, label = '0'] = version
  .replace(/[^\d.-]+/g, '')
  .split(/[.-]/);

export default defineManifest({
  manifest_version: 3,
  name: 'AlAi Agent',
  description:
    'An agentic AI browser assistant powered by OpenRouter. Open the side panel to chat with the current page, and let the agent click, type, and navigate for you.',
  version: `${major}.${minor}.${patch}.${label}`,
  version_name: version,
  permissions: [
    'sidePanel',
    'storage',
    'activeTab',
    'scripting',
    'tabs',
    'downloads',
    'offscreen',
  ],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  action: {
    default_title: 'AlAi Agent',
  },
  side_panel: {
    default_path: 'sidepanel/index.html',
  },
  options_page: 'options/index.html',
  content_scripts: [
    {
      matches: ['<all_urls>'],
      all_frames: true,
      js: ['src/content/index.ts'],
    },
  ],
  icons: {
    '16': 'icons/icon-16.png',
    '32': 'icons/icon-32.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
});
