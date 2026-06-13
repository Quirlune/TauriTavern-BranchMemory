import { bootstrapExtension, cleanExtensionData } from './src/app.js';

let started = false;

export function init() {
    if (started) {
        return;
    }

    started = true;
    void bootstrapExtension().catch((error) => {
        console.error('[BranchMemory] Failed to initialize', error);
        globalThis.toastr?.error?.(`Branch Memory 初始化失败：${error?.message || error}`);
    });
}

export async function clean() {
    await cleanExtensionData();
}
