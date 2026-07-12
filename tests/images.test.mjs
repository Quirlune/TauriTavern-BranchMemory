import assert from 'node:assert/strict';
import test from 'node:test';
import { imageGenerationNeedsConfirmation, RunPodClient } from '../src/images.js';

function response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

test('five or more generated images always require cost confirmation', () => {
    assert.equal(imageGenerationNeedsConfirmation(4), false);
    assert.equal(imageGenerationNeedsConfirmation(5), true);
    assert.equal(imageGenerationNeedsConfirmation(12), true);
});

test('RunPod client submits every job before polling the queue', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith('/run')) {
            return response({ id: `job-${calls.filter(call => call.url.endsWith('/run')).length}`, status: 'IN_QUEUE' });
        }
        const jobId = String(url).split('/').at(-1);
        return response({
            id: jobId,
            status: 'COMPLETED',
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
        assert.equal(results[1].imageUrl, 'data:image/png;base64,base64-job-2');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
