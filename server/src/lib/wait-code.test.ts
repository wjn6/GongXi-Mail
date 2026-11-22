import assert from 'node:assert/strict';
import test from 'node:test';
import {
    WAIT_CODE_MAX_CONCURRENT_PER_KEY,
    acquireWaitSlot,
    parseSinceParam,
    resolveDefaultSince,
    waitForVerificationCode,
    type WaitCodeFetchResult,
    type WaitCodeMessage,
} from './wait-code.js';

function message(id: string, subject: string, text: string, date: Date): WaitCodeMessage {
    return { id, from: 'noreply@example.com', subject, text, html: '', date: date.toISOString() };
}

function result(messages: WaitCodeMessage[]): WaitCodeFetchResult {
    return { messages, method: 'graph_api' };
}

void test('parseSinceParam accepts iso, seconds and milliseconds', () => {
    assert.equal(parseSinceParam(undefined), undefined);
    assert.equal(parseSinceParam(''), undefined);
    assert.equal(parseSinceParam('2026-11-23T00:00:00.000Z')?.toISOString(), '2026-11-23T00:00:00.000Z');
    assert.equal(parseSinceParam('1795392000')?.getTime(), 1795392000 * 1000);
    assert.equal(parseSinceParam(1795392000123)?.getTime(), 1795392000123);
    assert.equal(parseSinceParam('not-a-date'), null);
});

void test('resolveDefaultSince clamps allocation time to 10 minutes', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    assert.equal(resolveDefaultSince(now).toISOString(), '2026-11-23T11:59:00.000Z');
    assert.equal(
        resolveDefaultSince(now, new Date('2026-11-23T11:55:00Z')).toISOString(),
        '2026-11-23T11:55:00.000Z'
    );
    assert.equal(
        resolveDefaultSince(now, new Date('2026-11-22T00:00:00Z')).toISOString(),
        '2026-11-23T11:50:00.000Z'
    );
});

void test('acquireWaitSlot enforces per-key concurrency and is idempotent on release', () => {
    const releases = Array.from({ length: WAIT_CODE_MAX_CONCURRENT_PER_KEY }, () => acquireWaitSlot(999));
    assert.ok(releases.every(Boolean));
    assert.equal(acquireWaitSlot(999), null);
    assert.equal(acquireWaitSlot(1000) !== null, true); // 其它 Key 不受影响
    releases[0]?.();
    releases[0]?.();
    const extra = acquireWaitSlot(999);
    assert.ok(extra);
    assert.equal(acquireWaitSlot(999), null);
    [extra, ...releases.slice(1)].forEach((release) => release?.());
    const fresh = acquireWaitSlot(999);
    assert.ok(fresh);
    fresh();
});

void test('returns newest code that arrived after since, ignoring older mail', async () => {
    const since = new Date(Date.now() - 30_000);
    const found = await waitForVerificationCode(
        (mailbox) => Promise.resolve(result(mailbox === 'inbox'
            ? [
                message('old', 'Your code', 'Your code is 381904', new Date(since.getTime() - 60_000)),
                message('new', 'Your code', 'Your code is 527316', new Date(since.getTime() + 5_000)),
            ]
            : [])),
        { mailboxes: ['inbox', 'junk'], since, timeoutMs: 1000, intervalMs: 50 }
    );
    assert.equal(found?.code, '527316');
    assert.equal(found?.messageId, 'new');
    assert.equal(found?.matchedBy, 'auto');
    assert.equal(found?.attempts, 1);
});

void test('keeps polling until mail arrives, supports regex and junk folder', async () => {
    const since = new Date();
    let calls = 0;
    const found = await waitForVerificationCode(
        (mailbox) => {
            calls++;
            return Promise.resolve(result(mailbox === 'junk' && calls >= 4
                ? [message('j1', 'Login', 'Token: AB-9876', new Date(since.getTime() + 1_000))]
                : []));
        },
        { mailboxes: ['inbox', 'junk'], since, timeoutMs: 2000, intervalMs: 20, regex: /Token: ([A-Z]{2}-\d{4})/ }
    );
    assert.equal(found?.code, 'AB-9876');
    assert.equal(found?.mailbox, 'junk');
    assert.equal(found?.matchedBy, 'regex');
    assert.equal(found?.attempts, 2);
});

void test('times out with null and stops early when aborted', async () => {
    const empty = () => Promise.resolve(result([]));

    const started = Date.now();
    assert.equal(await waitForVerificationCode(empty, {
        mailboxes: ['inbox'], since: new Date(), timeoutMs: 120, intervalMs: 30,
    }), null);
    assert.ok(Date.now() - started >= 100);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const abortStarted = Date.now();
    assert.equal(await waitForVerificationCode(empty, {
        mailboxes: ['inbox'], since: new Date(), timeoutMs: 5000, intervalMs: 1000, signal: controller.signal,
    }), null);
    assert.ok(Date.now() - abortStarted < 1000);
});

void test('first fetch error is thrown, later errors are reported and retried', async () => {
    await assert.rejects(waitForVerificationCode(
        () => Promise.reject(new Error('token failed')),
        { mailboxes: ['inbox'], since: new Date(), timeoutMs: 500, intervalMs: 20 }
    ), /token failed/);

    const since = new Date();
    let calls = 0;
    const retryErrors: number[] = [];
    const found = await waitForVerificationCode(
        () => {
            calls++;
            if (calls === 2) return Promise.reject(new Error('transient'));
            return Promise.resolve(result(calls >= 3
                ? [message('m', 'Security code', 'code 864209', new Date(since.getTime() + 500))]
                : []));
        },
        {
            mailboxes: ['inbox'],
            since,
            timeoutMs: 2000,
            intervalMs: 20,
            onRetryError: (_err, _mailbox, attempt) => retryErrors.push(attempt),
        }
    );
    assert.equal(found?.code, '864209');
    assert.deepEqual(retryErrors, [2]);
});
