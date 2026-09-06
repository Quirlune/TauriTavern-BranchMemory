const SECRET_KEY_PATTERN = /(^|[-_])(api[-_]?key|authorization|password|passwd|access[-_]?token|refresh[-_]?token|id[-_]?token|cookie|set[-_]?cookie|proxy[-_]?password|client[-_]?secret|private[-_]?key|csrf[-_]?token)([-_]|$)|^(secret|token)$/i;
const REDACTED = '[REDACTED]';
const MAX_BODY_CHARS = 500000;

function redactString(value) {
    return String(value)
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
        .replace(/([?&]|\b)(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|csrf[_-]?token)=([^&\s]+)/gi, `$1$2=${REDACTED}`);
}

export function sanitizeMonitorValue(value, keyHint = '', seen = new WeakSet(), depth = 0) {
    if (SECRET_KEY_PATTERN.test(String(keyHint).replace(/([a-z])([A-Z])/g, '$1_$2'))) return REDACTED;
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value !== 'object') return String(value);
    if (depth > 16) return '[Maximum depth reached]';
    if (seen.has(value)) return '[Circular]';
    // Track ancestors, not siblings; repeated objects are not circular references.
    return sanitizeObject(value, keyHint, depth, seen);
}

function sanitizeObject(value, keyHint, depth, seen) {
    seen.add(value);
    try {

    if (value instanceof Date) return value.toISOString();
    if (typeof Headers !== 'undefined' && value instanceof Headers) {
        return sanitizeMonitorValue(Object.fromEntries(value.entries()), keyHint, seen, depth + 1);
    }
    if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
        return sanitizeMonitorValue(Object.fromEntries(value.entries()), keyHint, seen, depth + 1);
    }
    if (typeof FormData !== 'undefined' && value instanceof FormData) {
        const output = {};
        for (const [key, item] of value.entries()) {
            output[key] = typeof item === 'string' ? sanitizeMonitorValue(item, key, seen, depth + 1) : `[File ${item.name || 'blob'}, ${item.size || 0} bytes]`;
        }
        return output;
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        return `[Blob ${value.type || 'unknown'}, ${value.size} bytes]`;
    }
    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactString(value.message),
            stack: redactString(value.stack || '')
        };
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeMonitorValue(item, '', seen, depth + 1));
    }

    const output = {};
    for (const [key, item] of Object.entries(value)) {
        output[key] = sanitizeMonitorValue(item, key, seen, depth + 1);
    }
    return output;
    } finally { seen.delete(value); }
}

function parseBody(body) {
    if (body == null) return null;
    if (typeof body !== 'string') return sanitizeMonitorValue(body);
    try {
        return sanitizeMonitorValue(JSON.parse(body));
    } catch {
        return sanitizeMonitorValue(body);
    }
}

function headersObject(headers) {
    try {
        return sanitizeMonitorValue(Object.fromEntries(new Headers(headers || {}).entries()));
    } catch {
        return sanitizeMonitorValue(headers || {});
    }
}

async function requestSnapshot(input, init) {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    let body = init?.body;
    if (body == null && request) {
        try {
            body = await request.clone().text();
        } catch {
            body = '[Unreadable request body]';
        }
    }
    return {
        url: sanitizeMonitorValue(request?.url || String(input)),
        method: String(init?.method || request?.method || 'GET').toUpperCase(),
        headers: headersObject(init?.headers || request?.headers),
        body: parseBody(body),
        cache: init?.cache || request?.cache,
        credentials: init?.credentials || request?.credentials,
        mode: init?.mode || request?.mode,
        redirect: init?.redirect || request?.redirect
    };
}

function responseHeaders(response) {
    try {
        return headersObject(response.headers);
    } catch {
        return {};
    }
}

const EVENT_NAMES = [
    'GENERATION_STARTED',
    'GENERATION_AFTER_COMMANDS',
    'GENERATE_BEFORE_COMBINE_PROMPTS',
    'GENERATE_AFTER_COMBINE_PROMPTS',
    'GENERATE_AFTER_DATA',
    'CHAT_COMPLETION_PROMPT_READY',
    'CHAT_COMPLETION_SETTINGS_READY',
    'TEXT_COMPLETION_SETTINGS_READY',
    'GENERATION_ENDED',
    'GENERATION_STOPPED',
    'MESSAGE_RECEIVED',
    'TOOL_CALLS_PERFORMED'
];

export class RequestMonitor {
    constructor({ eventSource, eventTypes, onChange = () => {}, maxEvents = 300, nativeLogs = globalThis.__TAURITAVERN__?.api?.dev?.llmApiLogs }) {
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.onChange = onChange;
        this.maxEvents = maxEvents;
        this.records = [];
        this.active = false;
        this.sequence = 0;
        this.listeners = [];
        this.originalFetch = null;
        this.fetchWrapper = null;
        this.xhrOriginals = null;
        this.xhrWrappers = null;
        this.nativeLogs = nativeLogs;
        this.nativeStop = null;
        this.nativeVersion = 0;
        this.nativeState = nativeLogs ? 'idle' : 'unavailable';
        this.nativeSeen = new Set();
        this.rawLoads = new Map();
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.#attachEvents();
        this.#patchFetch();
        this.#patchXhr();
        void this.#attachNative();
        this.record('monitor', 'monitor_started', { note: '开始记录酒馆事件、fetch 与 XMLHttpRequest。敏感凭据会被脱敏。' });
        this.#notify();
    }

    stop() {
        if (!this.active) return;
        this.record('monitor', 'monitor_stopped', {});
        this.active = false;
        this.nativeVersion += 1;
        this.nativeStop?.();
        this.nativeStop = null;
        for (const { event, handler } of this.listeners) {
            this.eventSource.removeListener(event, handler);
        }
        this.listeners = [];
        if (this.fetchWrapper && globalThis.fetch === this.fetchWrapper) {
            globalThis.fetch = this.originalFetch;
        }
        this.#restoreXhr();
        this.#notify();
    }

    clear() {
        this.records = [];
        this.rawLoads.clear();
        this.#notify({ cleared: true });
    }

    snapshot() {
        return { active: this.active, records: [...this.records], maxEvents: this.maxEvents, nativeState: this.nativeState };
    }

    getRecord(id) {
        return this.records.find(record => record.id === id) || null;
    }

    record(channel, type, details, level = 'info') {
        if (!this.active) return null;
        const record = {
            id: `monitor-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`,
            timestamp: new Date(Number(details?.timestampMs) || Date.now()).toISOString(),
            channel,
            type,
            level,
            details: sanitizeMonitorValue(details)
        };
        this.records.push(record);
        if (this.records.length > this.maxEvents) {
            this.records.splice(0, this.records.length - this.maxEvents);
        }
        this.#notify({ record });
        return record;
    }

    #notify(extra = {}) {
        try { this.onChange({ ...this.snapshot(), ...extra }); }
        catch (error) { console.warn('[BranchMemory] Monitor UI failed', error); }
    }

    async #attachNative() {
        if (!this.nativeLogs) return;
        const version = ++this.nativeVersion;
        this.nativeState = 'connecting';
        const accept = entry => {
            if (!this.active || version !== this.nativeVersion || !entry?.id || this.nativeSeen.has(entry.id)) return;
            this.nativeSeen.add(entry.id);
            // Keep the deduplication window bounded independently of loaded request bodies.
            if (this.nativeSeen.size > this.maxEvents * 4) this.nativeSeen.delete(this.nativeSeen.values().next().value);
            this.record('native', 'provider_request', { ...entry, nativeLogId: entry.id }, entry.ok === false ? 'error' : 'info');
        };
        try {
            const stop = await this.nativeLogs.subscribeIndex(accept);
            if (!this.active || version !== this.nativeVersion) { stop(); return; }
            this.nativeStop = stop;
            const entries = await this.nativeLogs.index({ limit: Math.min(50, this.maxEvents) });
            if (version !== this.nativeVersion) return;
            for (const entry of entries) accept(entry);
            this.nativeState = 'connected';
            this.#notify();
        } catch (error) {
            if (version !== this.nativeVersion) return;
            this.nativeState = 'error';
            this.record('monitor', 'native_log_error', { error }, 'warn');
        }
    }

    async loadRecord(id) {
        const record = this.getRecord(id);
        if (!record || !record.details.nativeLogId || record.details.requestBody !== undefined) return record;
        if (this.rawLoads.has(id)) return this.rawLoads.get(id);
        const promise = (async () => {
            try {
                const raw = await this.nativeLogs.getRaw(record.details.nativeLogId);
                record.details.requestBody = parseBody(raw.requestRaw);
                // Responses have no bearing on prompt completeness; load them separately
                // as a bounded diagnostic to avoid putting huge SSE logs in the DOM.
                record.details.responseBody = parseBody(String(raw.responseRaw || '').slice(0, MAX_BODY_CHARS));
                record.details.responseTruncated = String(raw.responseRaw || '').length > MAX_BODY_CHARS;
                return record;
            } finally { this.rawLoads.delete(id); }
        })();
        this.rawLoads.set(id, promise);
        return promise;
    }

    #attachEvents() {
        for (const name of EVENT_NAMES) {
            const event = this.eventTypes[name];
            if (!event) continue;
            const handler = (...args) => this.record('event', name, { event, args });
            this.eventSource.on(event, handler);
            this.listeners.push({ event, handler });
        }
    }

    #patchFetch() {
        if (typeof globalThis.fetch !== 'function') return;
        this.originalFetch = globalThis.fetch;
        const originalFetch = this.originalFetch;
        const monitor = this;
        this.fetchWrapper = async function monitoredFetch(input, init) {
            if (!monitor.active || monitor.fetchWrapper !== monitoredFetch) return originalFetch.call(this, input, init);
            const requestId = `fetch-${Date.now().toString(36)}-${(++monitor.sequence).toString(36)}`;
            const startedAt = Date.now();
            let request = { url: String(input?.url || input) };
            try {
                request = await requestSnapshot(input, init);
                monitor.record('network', 'fetch_request', { requestId, ...request });
            } catch (error) {
                monitor.record('monitor', 'request_capture_error', { requestId, error }, 'warn');
            }
            try {
                const response = await originalFetch.call(this, input, init);
                const contentType = response.headers?.get?.('content-type') || '';
                const base = {
                    requestId,
                    url: request.url,
                    status: response.status,
                    statusText: response.statusText,
                    ok: response.ok,
                    redirected: response.redirected,
                    durationMs: Date.now() - startedAt,
                    headers: responseHeaders(response)
                };
                monitor.record('network', 'fetch_response', base, response.ok ? 'info' : 'error');
                if (/json|text\//i.test(contentType) && !/text\/event-stream|application\/x-ndjson/i.test(contentType)) {
                    void response.clone().text()
                        .then(text => monitor.record('network', 'fetch_response_body', {
                            requestId,
                            url: request.url,
                            body: parseBody(text),
                        }))
                        .catch(error => monitor.record('network', 'fetch_response_body_error', { requestId, url: request.url, error }, 'warn'));
                }
                return response;
            } catch (error) {
                monitor.record('network', 'fetch_error', { requestId, url: request.url, durationMs: Date.now() - startedAt, error }, 'error');
                throw error;
            }
        };
        globalThis.fetch = this.fetchWrapper;
    }

    #patchXhr() {
        const Xhr = globalThis.XMLHttpRequest;
        if (!Xhr?.prototype) return;
        const monitor = this;
        const originalOpen = Xhr.prototype.open;
        const originalSend = Xhr.prototype.send;
        const originalSetHeader = Xhr.prototype.setRequestHeader;
        this.xhrOriginals = { Xhr, originalOpen, originalSend, originalSetHeader };

        const openWrapper = function monitoredOpen(method, url, ...rest) {
            this.__ttbmMonitor = { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {} };
            return originalOpen.call(this, method, url, ...rest);
        };
        const setHeaderWrapper = function monitoredSetHeader(name, value) {
            if (this.__ttbmMonitor) this.__ttbmMonitor.headers[name] = value;
            return originalSetHeader.call(this, name, value);
        };
        const sendWrapper = function monitoredSend(body) {
            if (!monitor.active || monitor.xhrWrappers?.sendWrapper !== sendWrapper) return originalSend.call(this, body);
            const requestId = `xhr-${Date.now().toString(36)}-${(++monitor.sequence).toString(36)}`;
            const meta = this.__ttbmMonitor || { method: 'GET', url: '', headers: {} };
            const startedAt = Date.now();
            monitor.record('network', 'xhr_request', {
                requestId,
                method: meta.method,
                url: meta.url,
                headers: headersObject(meta.headers),
                body: parseBody(body)
            });
            this.addEventListener('loadend', () => {
                let responseBody = '[Binary or unavailable response]';
                try {
                    if (!this.responseType || this.responseType === 'text' || this.responseType === 'json') {
                        responseBody = this.responseType === 'json' ? this.response : parseBody(this.responseText);
                    }
                } catch {
                    responseBody = '[Unreadable response body]';
                }
                monitor.record('network', 'xhr_response', {
                    requestId,
                    url: meta.url,
                    status: this.status,
                    statusText: this.statusText,
                    durationMs: Date.now() - startedAt,
                    body: responseBody
                }, this.status >= 200 && this.status < 400 ? 'info' : 'error');
            }, { once: true });
            return originalSend.call(this, body);
        };
        Xhr.prototype.open = openWrapper;
        Xhr.prototype.setRequestHeader = setHeaderWrapper;
        Xhr.prototype.send = sendWrapper;
        this.xhrWrappers = { openWrapper, sendWrapper, setHeaderWrapper };
    }

    #restoreXhr() {
        if (!this.xhrOriginals) return;
        const { Xhr, originalOpen, originalSend, originalSetHeader } = this.xhrOriginals;
        const { openWrapper, sendWrapper, setHeaderWrapper } = this.xhrWrappers || {};
        if (Xhr.prototype.open === openWrapper) Xhr.prototype.open = originalOpen;
        if (Xhr.prototype.send === sendWrapper) Xhr.prototype.send = originalSend;
        if (Xhr.prototype.setRequestHeader === setHeaderWrapper) Xhr.prototype.setRequestHeader = originalSetHeader;
        this.xhrOriginals = null;
        this.xhrWrappers = null;
    }
}
