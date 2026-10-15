import fixture from './fixture.json';

// The preview uses repository excerpts, never the user's clipboard or database.
// Refuse all unprovided IPC so a UI proof cannot accidentally reach native features.
const commands: Record<string, unknown> = {
  get_app_name: 'PastePanda',
  get_app_version: '7.2.11',
  get_stats: { total: fixture.length, text_count: fixture.length, image_count: 0, file_count: 0, pinned: 0 },
  ai_get_config: { enabled: false, provider: '', api_key: '', model: '' },
  ai_get_status: { enabled: false, has_key: false },
  get_lan_sync_status: false,
  get_source_icon: null,
  get_regex_rules: [],
  rec_list_files: [],
  'plugin:event|listen': 1,
  'plugin:event|unlisten': null,
};
let callbackId = 0;
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
(window as any).__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    if (Object.prototype.hasOwnProperty.call(commands, command)) return commands[command];
    throw new Error(`源码分镜未启用原生命令：${command}`);
  },
  transformCallback: () => ++callbackId,
  unregisterCallback: () => {},
  convertFileSrc: () => '',
  metadata: { currentWindow: { label: 'source-preview' }, currentWebview: { label: 'source-preview' } },
};
if (window.location.pathname.endsWith('/surface.html')) await import('./surfaceMain');
else await import('./main');
