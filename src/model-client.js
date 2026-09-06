import { transformPrompt } from './prompt-control.js';

export function describeModelError(error) {
    const parts = [];
    const seen = new Set();
    while (error && !seen.has(error)) {
        seen.add(error);
        const message = typeof error === 'string' ? error : error.message || error.error?.message || error.response;
        if (message && !parts.includes(String(message))) parts.push(String(message));
        error = error.cause;
    }
    return parts.join(' → ') || '模型请求失败，未返回错误详情';
}

export class ModelClient {
    constructor({ generateRaw, connectionService, getSettings, monitor }) {
        Object.assign(this, { generateRaw, connectionService, getSettings, monitor });
        this.queue = Promise.resolve();
        this.revision = 0;
        this.controller = null;
    }

    cancel() {
        this.revision += 1;
        this.controller?.abort();
    }

    generate(request) {
        const revision = this.revision;
        const run = this.queue.then(async () => {
            if (revision !== this.revision) throw new DOMException('聊天已变化，取消旧调用', 'AbortError');
            return this.#send(request, revision);
        });
        this.queue = run.catch(() => {});
        return run;
    }

    async #send({ prompt, responseLength, apiConfig, scope = 'status', label = scope, signal }, revision) {
        const controller = new AbortController();
        this.controller = controller;
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const settings = this.getSettings();
        const messages = transformPrompt(prompt, settings.enabled ? settings.promptControl : { enabled: false }, scope);
        const requestId = `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this.monitor?.record('model', 'model_request', { requestId, scope, label, messages, responseLength, apiConfig });
        try {
            controller.signal.throwIfAborted();
            let result;
            if (apiConfig?.mode === 'connection_profile') {
                const profileId = String(apiConfig.connectionProfileId || '').trim();
                if (!profileId) throw new Error('已选择独立 API，但尚未选择 Connection Manager 配置。');
                const response = await this.connectionService.sendRequest(profileId, messages, responseLength, {
                    stream: false, extractData: true, includePreset: apiConfig.includePreset !== false,
                    includeInstruct: false, signal: controller.signal
                });
                result = typeof response === 'string' ? response : response?.content;
            } else {
                // generateRaw mutates host-wide temporary sampling settings. Serialize all
                // of our calls (including image planning) so those hooks cannot overlap.
                result = await this.generateRaw({ prompt: messages, responseLength, trimNames: false });
            }
            controller.signal.throwIfAborted();
            if (revision !== this.revision) throw new DOMException('聊天已变化，丢弃旧结果', 'AbortError');
            if (typeof result !== 'string' || !result.trim()) throw new Error('模型输出为空');
            this.monitor?.record('model', 'model_response', { requestId, scope, label, content: result });
            return result;
        } catch (error) {
            this.monitor?.record('model', 'model_error', { requestId, scope, label, error: describeModelError(error) }, 'error');
            if (error?.name === 'AbortError') throw error;
            throw new Error(`${label}：${describeModelError(error)}`, { cause: error });
        } finally {
            signal?.removeEventListener('abort', abort);
            if (this.controller === controller) this.controller = null;
        }
    }
}
