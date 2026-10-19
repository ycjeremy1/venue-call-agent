/**
 * The n8n webhook, against a real local HTTP server standing in for n8n.
 *
 * The property that matters is that a delivery reports what actually happened. A notifier that
 * says `ok` for a 500, a refused socket or a hang is a green light with nothing behind it, so each
 * of those is planted here and must come back NOT delivered — the controls for the one positive
 * case at the top.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { callResultPayload, createNotifier, parseWebhookUrl } from '../src/notify/n8n.ts';
import type { CallResultPayload } from '../src/notify/n8n.ts';
import { loadConfig } from '../src/config.ts';
import { failuresOf, notifyN8n, runCalls } from '../src/carrier/run.ts';

interface Received { method: string; contentType: string; body: CallResultPayload }

async function fakeN8n(status: number, opts: { hang?: boolean } = {}) {
    const received: Received[] = [];
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            received.push({
                method: req.method ?? '',
                contentType: req.headers['content-type'] ?? '',
                body: JSON.parse(raw) as CallResultPayload,
            });
            if (opts.hang) return;
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end('{"message":"Workflow was started"}');
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/webhook/venue-call-result`,
        received,
        close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}

const rows = await runCalls({ only: 'plain' });
const row = rows[0]!;

describe('a delivery n8n accepted is reported as delivered, with the call in the body', () => {
    test('one POST per call, JSON, marked simulated', async () => {
        const n8n = await fakeN8n(200);
        try {
            const deliveries = await notifyN8n(rows, 'stub', createNotifier({ url: n8n.url }));
            assert.deepEqual(deliveries.map((d) => d.ok), rows.map(() => true));
            assert.equal(n8n.received.length, rows.length);
            const got = n8n.received[0]!;
            assert.equal(got.method, 'POST');
            assert.match(got.contentType, /^application\/json/);
            assert.equal(got.body.simulated, true);
            assert.equal(got.body.leg, 'fake-leg');
            assert.equal(got.body.schema, 'venue-call-agent.call-result/1');
            assert.equal(got.body.fixture, row.fixture.name);
            assert.equal(got.body.endedBecause, row.transcript.endedBecause);
            assert.equal(got.body.transcript.length, row.transcript.lines.length);
        } finally {
            await n8n.close();
        }
    });

    test('the verdict sent is the verdict the run printed, not a second opinion', () => {
        const { hard, soft } = failuresOf(row);
        const payload = callResultPayload({
            fixture: row.fixture, agent: 'stub', transcript: row.transcript, audio: row.audio,
            hardFailures: hard, softFailures: soft,
        });
        assert.equal(payload.verdict, hard.length ? 'hard' : soft.length ? 'soft' : 'clean');
        assert.deepEqual(payload.hardFailures, hard);
    });

    test('a planted hard failure is sent as hard', () => {
        const payload = callResultPayload({
            fixture: row.fixture, agent: 'stub', transcript: row.transcript, audio: row.audio,
            hardFailures: ['planted'], softFailures: [],
        });
        assert.equal(payload.verdict, 'hard');
    });
});

describe('🔴 controls — each of these must come back NOT delivered', () => {
    test('n8n answers 500', async () => {
        const n8n = await fakeN8n(500);
        try {
            const [d] = await notifyN8n(rows, 'stub', createNotifier({ url: n8n.url }));
            assert.equal(d!.ok, false);
            assert.equal(d!.detail, 'HTTP 500');
        } finally {
            await n8n.close();
        }
    });

    test('nothing is listening', async () => {
        const n8n = await fakeN8n(200);
        await n8n.close();
        const [d] = await notifyN8n(rows, 'stub', createNotifier({ url: n8n.url }));
        assert.equal(d!.ok, false);
        assert.match(d!.detail, /^transport: /);
        assert.doesNotMatch(d!.detail, /127\.0\.0\.1/, 'the detail must not carry the URL');
    });

    test('n8n accepts the request and never answers', async () => {
        const n8n = await fakeN8n(200, { hang: true });
        try {
            const [d] = await notifyN8n(rows, 'stub', createNotifier({ url: n8n.url, timeoutMs: 200 }));
            assert.equal(d!.ok, false);
            assert.equal(d!.detail, 'no answer within 200ms');
        } finally {
            await n8n.close();
        }
    });
});

describe('N8N_WEBHOOK_URL', () => {
    test('unset means empty, and the local path still boots with nothing', () => {
        assert.equal(loadConfig({}).n8nWebhookUrl, '');
        assert.equal(loadConfig({ N8N_WEBHOOK_URL: '   ' }).n8nWebhookUrl, '');
    });

    test('a real URL is used', () => {
        assert.equal(
            loadConfig({ N8N_WEBHOOK_URL: ' https://n8n.example/webhook/abc ' }).n8nWebhookUrl,
            'https://n8n.example/webhook/abc',
        );
    });

    for (const bad of ['not a url', 'ftp://n8n.example/webhook/abc', 'file:///etc/passwd']) {
        test(`${JSON.stringify(bad)} is refused at boot, without echoing it`, () => {
            assert.throws(() => loadConfig({ N8N_WEBHOOK_URL: bad }), (error: unknown) => {
                const message = (error as Error).message;
                assert.match(message, /refuses to start/);
                assert.ok(!message.includes(bad), 'the refusal must not repeat the value');
                return true;
            });
        });
    }

    test('parseWebhookUrl is the same check loadConfig uses', () => {
        assert.throws(() => parseWebhookUrl('nope'), /not a URL/);
    });
});
