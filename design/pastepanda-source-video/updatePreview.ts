export function friendlyError(raw: string) { return { friendly: raw, raw }; }
export function useUpdate() {
  return {
    status: 'idle', update: null, progress: 0, progressIndeterminate: false,
    downloadedBytes: 0, bytesPerSec: 0, error: null,
    checkForUpdate: async () => {}, downloadAndInstall: async () => {},
    restart: async () => {}, markInstalled: () => {}, skipThisVersion: () => {},
  };
}
