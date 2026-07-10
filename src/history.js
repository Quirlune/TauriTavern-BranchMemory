import { appendMessagesToSnapshot, buildSnapshot, canonicalMessage, hashString } from './core.js';

const PAGE_SIZE = 240;
const PAGE_BATCH = 8;
let historyCache = new WeakMap();

function cacheableHandle(handle) {
    return handle && (typeof handle === 'object' || typeof handle === 'function');
}

function rememberHistory(handle, snapshot, fingerprints = null) {
    if (cacheableHandle(handle)) {
        historyCache.set(handle, {
            snapshot,
            fingerprints: fingerprints || snapshot.messages.map(message => canonicalMessage(message))
        });
    }
    return snapshot;
}

function snapshotFromTailCache(cachedRecord, tail) {
    const cached = cachedRecord?.snapshot;
    if (!cached) return null;
    const fingerprints = cachedRecord.fingerprints || cached.messages.map(message => canonicalMessage(message));

    const tailMessages = Array.isArray(tail?.messages) ? tail.messages : [];
    const tailStart = Math.max(0, Math.floor(Number(tail?.startIndex) || 0));
    const tailEnd = tailStart + tailMessages.length;
    const cachedLength = cached.messages.length;

    if (!tailMessages.length) {
        return cachedLength === 0
            ? { snapshot: cached, fingerprints }
            : { snapshot: buildSnapshot([]), fingerprints: [] };
    }

    if (tailStart === 0 && tailEnd === cachedLength) {
        if (tailMessages.every((message, offset) => canonicalMessage(message) === fingerprints[offset])) {
            return { snapshot: cached, fingerprints };
        }
        return {
            snapshot: buildSnapshot(tailMessages),
            fingerprints: tailMessages.map(message => canonicalMessage(message))
        };
    }

    if (tailEnd === cachedLength && tailStart < cachedLength) {
        const unchanged = tailMessages.every((message, offset) => canonicalMessage(message) === fingerprints[tailStart + offset]);
        return unchanged ? { snapshot: cached, fingerprints } : null;
    }

    if (tailStart <= cachedLength && cachedLength < tailEnd) {
        const overlap = cachedLength - tailStart;
        if (overlap <= 0) return null;
        for (let offset = 0; offset < overlap; offset += 1) {
            if (canonicalMessage(tailMessages[offset]) !== fingerprints[tailStart + offset]) {
                return null;
            }
        }
        const additions = tailMessages.slice(overlap);
        return {
            snapshot: appendMessagesToSnapshot(cached, additions),
            fingerprints: [...fingerprints, ...additions.map(message => canonicalMessage(message))]
        };
    }

    return null;
}

export function clearHistoryCache(handle = null) {
    if (handle && cacheableHandle(handle)) {
        historyCache.delete(handle);
        return;
    }
    historyCache = new WeakMap();
}

export async function readFullHistory(handle, { force = false } = {}) {
    let page = await handle.history.tail({ limit: PAGE_SIZE });
    if (!force && cacheableHandle(handle)) {
        const cached = historyCache.get(handle);
        const resolved = snapshotFromTailCache(cached, page);
        if (resolved) return rememberHistory(handle, resolved.snapshot, resolved.fingerprints);
    }

    const pages = [page];

    while (page.hasMoreBefore) {
        const batch = await handle.history.beforePages(page, { limit: PAGE_SIZE, pages: PAGE_BATCH });
        if (!Array.isArray(batch) || batch.length === 0) {
            break;
        }
        pages.push(...batch);
        page = batch.at(-1);
    }

    pages.sort((left, right) => left.startIndex - right.startIndex);
    const messages = pages.flatMap(item => item.messages || []);
    return rememberHistory(handle, buildSnapshot(messages));
}

export async function locateLatestAssistantMessage(handle, { scanLimit = 2000 } = {}) {
    if (typeof handle?.locate?.findLastMessage !== 'function') return null;
    try {
        return await handle.locate.findLastMessage({
            role: 'assistant',
            scanLimit
        });
    } catch (error) {
        console.warn('[BranchMemory] Chat locate.findLastMessage unavailable, falling back to history scan', error);
        return null;
    }
}

export function scopeHashForRef(ref) {
    if (!ref) return hashString('unknown');
    if (ref.kind === 'character') {
        return hashString(`character:${ref.characterId}`);
    }
    // Group branch identifiers may change. The cumulative message chain in the
    // cache key still prevents unrelated conversations from matching.
    return hashString('group');
}

export function chatIdentity(ref) {
    if (!ref) return 'unknown';
    if (ref.kind === 'character') {
        return `character:${ref.characterId}:${ref.fileName}`;
    }
    return `group:${ref.chatId}`;
}

export function characterPromptInfo(ref) {
    if (ref?.kind === 'character') {
        const id = String(ref.characterId || ref.fileName || ref.name || 'unknown');
        const fileName = String(ref.fileName || '');
        return {
            kind: 'character',
            key: `character:${id}`,
            label: String(ref.name || ref.characterName || fileName || ref.characterId || '当前角色'),
            characterId: String(ref.characterId || ''),
            fileName
        };
    }

    if (ref?.kind === 'group') {
        const id = String(ref.chatId || ref.groupId || 'current');
        return {
            kind: 'group',
            key: `group:${id}`,
            label: String(ref.name || ref.groupName || '当前群聊'),
            characterId: '',
            fileName: ''
        };
    }

    return {
        kind: 'unknown',
        key: 'unknown',
        label: '当前聊天',
        characterId: '',
        fileName: ''
    };
}
