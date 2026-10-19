/**
 * After a call, tell an n8n workflow what happened. Optional, off unless `N8N_WEBHOOK_URL` is set.
 *
 * One POST per call, JSON, to an n8n "Webhook" trigger node. What n8n does next — a Slack
 * message, a row in a sheet, a ticket — is the workflow's business and none of this repo's.
 *
 * 🔴 EVERY PAYLOAD SAYS WHERE THE CALL HAPPENED. Today that is always `fake-leg`: no carrier
 * exists, so every "call" is a fixture played against nobody. A workflow that files a fake call as
 * a real one would be the exact confusion `docs/WHAT-CANNOT-BE-TESTED.md` exists to prevent, so
 * `simulated` is a field the receiver can branch on rather than something it has to infer.
 *
 * 🔴 A DELIVERY FAILURE NEVER CHANGES A CALL'S VERDICT. The call is scored before anything is
 * sent. A webhook that is down is reported as a webhook that is down — loudly, and as its own
 * count — never as a call that failed, and never swallowed.
 *
 * The URL is never printed. An n8n webhook path is often the only thing guarding the workflow.
 */

import type { CallTranscript } from '../agent/contract.ts';
import type { AudioReport } from '../carrier/call.ts';
import type { Fixture } from '../harness/replay.ts';

export interface CallResultPayload {
    /** Bump when a field changes meaning, so a workflow can refuse a shape it does not know. */
    schema: 'venue-call-agent.call-result/1';
    /** Where the audio went. `fake-leg` until a carrier exists; see src/carrier/fakeLeg.ts. */
    leg: 'fake-leg';
    simulated: true;
    fixture: string;
    scenario: string;
    agent: string;
    endedBecause: string;
    refusalReason?: string;
    verdict: 'clean' | 'soft' | 'hard';
    hardFailures: string[];
    softFailures: string[];
    audio: {
        callMs: number;
        openingDelayMs: number;
        deadAirP50Ms: number;
        maxDeadAirMs: number;
        talkOverFrames: number;
        hangup: string;
    };
    transcript: { who: string; text: string }[];
    sentAt: string;
}

export interface Delivery {
    fixture: string;
    ok: boolean;
    /** HTTP status, or the transport error. Never the URL. */
    detail: string;
}

export interface NotifierOptions {
    url: string;
    /** Per request. n8n answers a webhook immediately unless the workflow is set to wait. */
    timeoutMs?: number;
    /** Injectable for tests. Defaults to the global fetch. */
    fetch?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 5000;

export interface CallOutcome {
    fixture: Pick<Fixture, 'name' | 'scenario'>;
    agent: string;
    transcript: CallTranscript;
    audio: AudioReport;
    hardFailures: string[];
    softFailures: string[];
}

/** One call, as the receiving workflow sees it. Built from the verdict, never ahead of it. */
export function callResultPayload(outcome: CallOutcome, now: Date = new Date()): CallResultPayload {
    const { audio, transcript } = outcome;
    return {
        schema: 'venue-call-agent.call-result/1',
        leg: 'fake-leg',
        simulated: true,
        fixture: outcome.fixture.name,
        scenario: outcome.fixture.scenario,
        agent: outcome.agent,
        endedBecause: transcript.endedBecause,
        ...(transcript.refusalReason ? { refusalReason: transcript.refusalReason } : {}),
        verdict: outcome.hardFailures.length ? 'hard' : outcome.softFailures.length ? 'soft' : 'clean',
        hardFailures: [...outcome.hardFailures],
        softFailures: [...outcome.softFailures],
        audio: {
            callMs: audio.callMs,
            openingDelayMs: audio.openingDelayMs,
            deadAirP50Ms: audio.percentiles.p50 ?? 0,
            maxDeadAirMs: audio.maxDeadAirMs,
            talkOverFrames: audio.talkOverFrames,
            hangup: audio.endedBecause,
        },
        transcript: transcript.lines.map((l) => ({ who: l.who, text: l.text })),
        sentAt: now.toISOString(),
    };
}

/**
 * A webhook URL, or a refusal that does not repeat it.
 *
 * Checked at boot rather than at the first POST: a typo found after fifteen calls have run is
 * fifteen results nobody received.
 */
export function parseWebhookUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('N8N_WEBHOOK_URL is not a URL. Copy the full Production URL from the n8n Webhook node, or leave it unset.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`N8N_WEBHOOK_URL must be http or https, not ${url.protocol}`);
    }
    return url.toString();
}

export function createNotifier(options: NotifierOptions) {
    const doFetch = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return async function send(payload: CallResultPayload): Promise<Delivery> {
        try {
            const response = await doFetch(options.url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(timeoutMs),
            });
            // Drain it so the socket is released; n8n's body is not ours to interpret.
            await response.arrayBuffer().catch(() => undefined);
            return { fixture: payload.fixture, ok: response.ok, detail: `HTTP ${response.status}` };
        } catch (error) {
            const err = error as Error & { cause?: { code?: string } };
            // The cause's code (ECONNREFUSED, ENOTFOUND) rather than its message, which can
            // carry the host — and the host is part of the URL this file promises not to print.
            const detail = err.name === 'TimeoutError'
                ? `no answer within ${timeoutMs}ms`
                : `transport: ${err.cause?.code ?? 'request failed before any response'}`;
            return { fixture: payload.fixture, ok: false, detail };
        }
    };
}
