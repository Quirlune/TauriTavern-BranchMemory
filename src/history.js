import { buildSnapshot, hashString } from './core.js';

const PAGE_SIZE = 240;
const PAGE_BATCH = 8;

export async function readFullHistory(handle) {
    let page = await handle.history.tail({ limit: PAGE_SIZE });
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
    return buildSnapshot(messages);
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
