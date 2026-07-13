import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_SETTINGS, migrateRunPodEndpointId } from '../src/defaults.js';
import {
    imageAnchorIds,
    imageCachePrefix,
    imageDisplayTextWithAnchors,
    imageGenerationNeedsConfirmation,
    imageMessageCachePrefix,
    imageMessageIdentity,
    insertImageAnchorTags,
    RunPodClient,
    stripImageAnchorTags
} from '../src/images.js';
import { segmentImageSource } from '../src/core.js';

function response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

test('five or more generated images always require cost confirmation', () => {
    assert.equal(imageGenerationNeedsConfirmation(4), false);
    assert.equal(imageGenerationNeedsConfirmation(5), true);
    assert.equal(imageGenerationNeedsConfirmation(12), true);
});

test('image regeneration cache prefix covers every recipe for the same branch floor', () => {
    const prefix = imageCachePrefix({ scopeHash: 'scope', floor: 7, chain: 'chain' });
    assert.equal(prefix, 'v1.scope.7.chain.');
    assert.equal('v1.scope.7.chain.recipe-a'.startsWith(prefix), true);
    assert.equal('v1.scope.7.other.recipe-a'.startsWith(prefix), false);
    assert.equal('v1.scope.8.chain.recipe-a'.startsWith(prefix), false);
});

test('persistent image identity survives edits but changes on swipe', () => {
    const base = { is_user: false, name: 'AI', mes: 'original', send_date: 'stable-date', swipe_id: 2 };
    const edited = { ...base, mes: 'edited a few words' };
    const swiped = { ...edited, swipe_id: 3 };
    const identity = imageMessageIdentity({ chatKey: 'character:1:file', floor: 7, message: base, messageIndex: 8 });
    assert.equal(imageMessageIdentity({ chatKey: 'character:1:file', floor: 7, message: edited, messageIndex: 8 }), identity);
    assert.notEqual(imageMessageIdentity({ chatKey: 'character:1:file', floor: 7, message: swiped, messageIndex: 8 }), identity);
    assert.equal(imageMessageCachePrefix(identity), `v2.${identity}.`);
});

test('image XML anchors are persisted at planned segments and can be stripped for planning', () => {
    const source = 'First paragraph.\n\nSecond paragraph.';
    const segmented = segmentImageSource(source);
    const anchored = insertImageAnchorTags(source, [
        { anchorId: 'anchor-one', segmentIndex: 1 },
        { anchorId: 'anchor-two', segmentIndex: 2 }
    ], segmented);
    assert.match(anchored, /First paragraph\.<span data-ttbm-image-anchor="anchor-one"><\/span>/);
    assert.match(anchored, /Second paragraph\.<span data-ttbm-image-anchor="anchor-two"><\/span>/);
    assert.deepEqual(imageAnchorIds(anchored), ['anchor-one', 'anchor-two']);
    assert.equal(stripImageAnchorTags(anchored), source);
});

test('image XML anchors are copied into the display text consumed by host regex rules', () => {
    const displayText = 'Rendered first paragraph.\n\nRendered second paragraph.';
    const anchored = imageDisplayTextWithAnchors(displayText, [
        { anchorId: 'regex-visible-anchor', segmentIndex: 1 }
    ]);
    assert.match(anchored, /Rendered first paragraph\.<span data-ttbm-image-anchor="regex-visible-anchor"><\/span>/);
    assert.equal(stripImageAnchorTags(anchored), displayText);
});

test('persisted anchor hiding does not hide rendered image wrappers', async () => {
    const [source, stylesheet] = await Promise.all([
        readFile(new URL('../src/images.js', import.meta.url), 'utf8'),
        readFile(new URL('../style.css', import.meta.url), 'utf8')
    ]);
    assert.doesNotMatch(source, /wrapper\.dataset\.ttbmImageAnchor\s*=/);
    assert.match(stylesheet, /\[data-ttbm-image-anchor\]:not\(\.ttbm-image-inline\)/);
});

test('default image workflow points to the current RunPod endpoint', () => {
    assert.equal(DEFAULT_SETTINGS.image.runpod.endpointId, 'quvu6qr8iey7lw');
    assert.equal(migrateRunPodEndpointId('s7bx1d50mv9zkj'), 'quvu6qr8iey7lw');
    assert.equal(migrateRunPodEndpointId('custom-endpoint'), 'custom-endpoint');
});

test('RunPod client submits every job before polling, then checks statuses concurrently', { timeout: 1000 }, async () => {
    const calls = [];
    let statusCallsStarted = 0;
    let releaseStatuses;
    const statusGate = new Promise(resolve => { releaseStatuses = resolve; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith('/run')) {
            return response({ id: `job-${calls.filter(call => call.url.endsWith('/run')).length}`, status: 'IN_QUEUE' });
        }
        const jobId = String(url).split('/').at(-1);
        statusCallsStarted += 1;
        if (statusCallsStarted === 2) releaseStatuses();
        await statusGate;
        return response({
            id: jobId,
            status: 'COMPLETED',
            delayTime: jobId === 'job-1' ? 12000 : 34000,
            executionTime: jobId === 'job-1' ? 27000 : 10000,
            output: { images: [{ filename: `${jobId}.png`, type: 'base64', data: `base64-${jobId}` }] }
        });
    };

    try {
        const client = new RunPodClient(() => ({
            image: {
                runpod: {
                    apiKey: 'test-key',
                    apiBase: 'https://example.invalid/v2',
                    endpointId: 'endpoint',
                    width: 1024,
                    height: 1280,
                    seed: 7,
                    randomSeed: false,
                    positivePromptPrefix: 'quality',
                    pollIntervalMs: 500,
                    maxPolls: 1
                }
            }
        }));
        const results = await client.generateBatch(['first', 'second']);
        assert.deepEqual(calls.map(call => call.url), [
            'https://example.invalid/v2/endpoint/run',
            'https://example.invalid/v2/endpoint/run',
            'https://example.invalid/v2/endpoint/status/job-1',
            'https://example.invalid/v2/endpoint/status/job-2'
        ]);
        assert.equal(JSON.parse(calls[0].options.body).input.positive_prompt, 'quality, first');
        assert.equal('negative_prompt' in JSON.parse(calls[0].options.body).input, false);
        assert.equal(statusCallsStarted, 2);
        assert.equal(results[1].imageUrl, 'data:image/png;base64,base64-job-2');
        assert.deepEqual(results[1].metrics.delayTimeMs, 34000);
        assert.deepEqual(results[1].metrics.executionTimeMs, 10000);
        assert.equal(Number.isFinite(results[1].metrics.clientElapsedMs), true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
