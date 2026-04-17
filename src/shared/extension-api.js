export const extensionApi = globalThis.browser ?? globalThis.chrome;

if (!extensionApi) {
  throw new Error('WebExtension API is not available');
}