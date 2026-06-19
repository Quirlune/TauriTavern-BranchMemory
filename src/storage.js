import {
    CHAT_RUNTIME_KEY,
    EXTENSION_NAMESPACE,
    IMAGE_TABLE,
    LARGE_TABLE,
    SETTINGS_KEY,
    SETTINGS_TABLE,
    SMALL_TABLE,
    STATUS_TABLE
} from './defaults.js';

export async function waitForTauriHost() {
    const ready = globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__;
    if (ready) {
        await ready;
    }

    const host = globalThis.__TAURITAVERN__;
    if (!host?.api?.chat || !host?.api?.extension?.store) {
        throw new Error('此扩展需要带 Chat API 与 Extension Store API 的 TauriTavern。');
    }
    return host;
}

export class StorageGateway {
    constructor(host) {
        this.host = host;
        this.globalStore = host.api.extension.store;
    }

    currentHandle() {
        return this.host.api.chat.current.handle();
    }

    currentRef() {
        return this.host.api.chat.current.ref();
    }

    async loadSettings() {
        const result = await this.globalStore.tryGetJson({
            namespace: EXTENSION_NAMESPACE,
            table: SETTINGS_TABLE,
            key: SETTINGS_KEY
        });
        return result?.found ? result.value : null;
    }

    async saveSettings(settings) {
        await this.globalStore.setJson({
            namespace: EXTENSION_NAMESPACE,
            table: SETTINGS_TABLE,
            key: SETTINGS_KEY,
            value: settings
        });
    }

    async tryGetRecord(table, key) {
        const result = await this.globalStore.tryGetJson({
            namespace: EXTENSION_NAMESPACE,
            table,
            key
        });
        return result?.found ? result.value : null;
    }

    async setRecord(table, key, value) {
        await this.globalStore.setJson({
            namespace: EXTENSION_NAMESPACE,
            table,
            key,
            value
        });
    }

    async getSmall(key) {
        return this.tryGetRecord(SMALL_TABLE, key);
    }

    async setSmall(key, value) {
        return this.setRecord(SMALL_TABLE, key, value);
    }

    async listSmallKeys() {
        return this.globalStore.listKeys({ namespace: EXTENSION_NAMESPACE, table: SMALL_TABLE });
    }

    async getLarge(key) {
        return this.tryGetRecord(LARGE_TABLE, key);
    }

    async setLarge(key, value) {
        return this.setRecord(LARGE_TABLE, key, value);
    }

    async listLargeKeys() {
        return this.globalStore.listKeys({ namespace: EXTENSION_NAMESPACE, table: LARGE_TABLE });
    }

    async getStatus(key) {
        return this.tryGetRecord(STATUS_TABLE, key);
    }

    async setStatus(key, value) {
        return this.setRecord(STATUS_TABLE, key, value);
    }

    async getImage(key) {
        return this.tryGetRecord(IMAGE_TABLE, key);
    }

    async setImage(key, value) {
        return this.setRecord(IMAGE_TABLE, key, value);
    }

    async deleteImage(key) {
        await this.globalStore.deleteJson({ namespace: EXTENSION_NAMESPACE, table: IMAGE_TABLE, key });
    }

    async listImageKeys() {
        return this.globalStore.listKeys({ namespace: EXTENSION_NAMESPACE, table: IMAGE_TABLE });
    }

    async getChatRuntime(handle = this.currentHandle()) {
        try {
            return await handle.store.getJson({ namespace: EXTENSION_NAMESPACE, key: CHAT_RUNTIME_KEY });
        } catch {
            return null;
        }
    }

    async setChatRuntime(value, handle = this.currentHandle()) {
        await handle.store.setJson({ namespace: EXTENSION_NAMESPACE, key: CHAT_RUNTIME_KEY, value });
    }

    async cleanAll() {
        for (const table of [SETTINGS_TABLE, SMALL_TABLE, LARGE_TABLE, STATUS_TABLE, IMAGE_TABLE]) {
            try {
                await this.globalStore.deleteTable({ namespace: EXTENSION_NAMESPACE, table });
            } catch (error) {
                console.warn(`[BranchMemory] Unable to delete table ${table}`, error);
            }
        }
    }
}
