// Load the SDK through CommonJS. Scrypted 0.147 runs plugins as CommonJS and
// the published SDK's ESM interop path can otherwise initialize before the
// server has exposed its static runtime object.
const sdkModule = require('@scrypted/sdk') as typeof import('@scrypted/sdk');

export const sdk = sdkModule.default;
export const {
    LockState,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedMimeTypes,
} = sdkModule;

export const { StorageSettings } = require('@scrypted/sdk/storage-settings') as typeof import('@scrypted/sdk/storage-settings');
export const { deviceManager, mediaManager } = sdk;
