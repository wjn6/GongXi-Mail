import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SendRequestError,
    buildGraphSendPayload,
    classifyGraphSendError,
    computeRequestHash,
    hasMailSendScope,
    normalizeAddressList,
    normalizeSendRequest,
    parseMailAddress,
    parseRetryAfterSeconds,
    sortSenderCandidates,
} from './send-mail.js';

void test('parses plain and named addresses', () => {
    assert.deepEqual(parseMailAddress('a@b.com'), { address: 'a@b.com' });
    assert.deepEqual(parseMailAddress('Acme <onboarding@acme.dev>'), { address: 'onboarding@acme.dev', name: 'Acme' });
    assert.deepEqual(parseMailAddress('"Acme, Inc" <x@acme.dev>'), { address: 'x@acme.dev', name: 'Acme, Inc' });
    assert.equal(parseMailAddress('not-an-email'), null);
    assert.equal(parseMailAddress('Name <bad>'), null);
});

void test('normalizes address lists and dedupes case-insensitively', () => {
    assert.deepEqual(normalizeAddressList(['A@x.com', 'a@X.com', 'b@x.com'], 'to').map((a) => a.address), ['A@x.com', 'b@x.com']);
    assert.deepEqual(normalizeAddressList('c@x.com', 'cc'), [{ address: 'c@x.com' }]);
    assert.throws(() => normalizeAddressList(['ok@x.com', 'bad'], 'to'), SendRequestError);
    assert.throws(() => normalizeAddressList([123], 'to'), SendRequestError);
});

void test('validates required fields like Resend', () => {
    assert.throws(() => normalizeSendRequest({ to: [], subject: 's', text: 't' }), /Missing `to` field/);
    assert.throws(() => normalizeSendRequest({ to: 'a@x.com', subject: '', text: 't' }), /Missing `subject` field/);
    assert.throws(() => normalizeSendRequest({ to: 'a@x.com', subject: 's' }), /Missing `html` or `text` field/);
    const tooMany = Array.from({ length: 51 }, (_, i) => `u${i}@x.com`);
    assert.throws(() => normalizeSendRequest({ to: tooMany, subject: 's', text: 't' }), /At most 50/);
});

void test('rejects non X- headers instead of dropping them', () => {
    assert.throws(
        () => normalizeSendRequest({ to: 'a@x.com', subject: 's', text: 't', headers: { 'List-Unsubscribe': '<x>' } }),
        /Only custom headers starting with `X-`/
    );
    const ok = normalizeSendRequest({ to: 'a@x.com', subject: 's', text: 't', headers: { 'X-Entity-Ref-ID': '123' } });
    assert.deepEqual(ok.headers, [{ name: 'X-Entity-Ref-ID', value: '123' }]);
});

void test('validates attachments and size limit', () => {
    const content = Buffer.from('hello').toString('base64');
    const ok = normalizeSendRequest({
        to: 'a@x.com', subject: 's', html: '<p>x</p>',
        attachments: [{ filename: 'a.txt', content }, { filename: 'logo.png', content, contentId: '<logo>' }],
    });
    assert.equal(ok.attachments.length, 2);
    assert.equal(ok.attachments[0].contentType, 'text/plain');
    assert.equal(ok.attachments[1].contentId, 'logo');
    assert.equal(ok.attachmentBytes, 10);

    assert.throws(() => normalizeSendRequest({
        to: 'a@x.com', subject: 's', text: 't', attachments: [{ filename: 'a.txt', content: '%%%' }],
    }), /valid base64/);
    const big = Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64');
    assert.throws(() => normalizeSendRequest({
        to: 'a@x.com', subject: 's', text: 't', attachments: [{ filename: 'big.bin', content: big }],
    }), /exceed 3 MB/);
});

void test('builds Graph sendMail payload', () => {
    const request = normalizeSendRequest({
        to: ['Bob <bob@x.com>'],
        cc: 'cc@x.com',
        replyTo: 'r@x.com',
        subject: 'Hi',
        html: '<b>hi</b>',
        text: 'hi',
        fromName: 'Acme',
        attachments: [{ filename: 'a.txt', content: Buffer.from('x').toString('base64') }],
    });
    const payload = buildGraphSendPayload(request, 'sender@outlook.com');
    const message = payload.message as Record<string, unknown>;
    assert.deepEqual(message.body, { contentType: 'HTML', content: '<b>hi</b>' });
    assert.deepEqual(message.toRecipients, [{ emailAddress: { address: 'bob@x.com', name: 'Bob' } }]);
    assert.deepEqual(message.from, { emailAddress: { address: 'sender@outlook.com', name: 'Acme' } });
    assert.equal((message.attachments as unknown[]).length, 1);
    assert.equal(payload.saveToSentItems, true);

    const textOnly = buildGraphSendPayload(normalizeSendRequest({ to: 'a@x.com', subject: 's', text: 'plain' }), 's@o.com');
    assert.deepEqual((textOnly.message as Record<string, unknown>).body, { contentType: 'Text', content: 'plain' });
    assert.equal((textOnly.message as Record<string, unknown>).from, undefined);
});

void test('classifies Graph send errors', () => {
    const throttled = classifyGraphSendError(429, '{"error":{"code":"ApplicationThrottled","message":"slow down"}}', '120');
    assert.equal(throttled.kind, 'THROTTLED');
    assert.equal(throttled.cooldownSeconds, 120);
    assert.equal(throttled.retryOtherAccount, true);

    const blocked = classifyGraphSendError(403, '{"error":{"code":"ErrorMessageSubmissionBlocked","message":"blocked"}}');
    assert.equal(blocked.kind, 'BLOCKED');
    assert.equal(blocked.cooldownSeconds, 24 * 60 * 60);
    assert.equal(blocked.markDenied, false);

    const denied = classifyGraphSendError(403, '{"error":{"code":"ErrorAccessDenied","message":"no"}}');
    assert.equal(denied.kind, 'PERMISSION');
    assert.equal(denied.markDenied, true);

    const bad = classifyGraphSendError(400, '{"error":{"code":"ErrorInvalidRecipients","message":"bad recipient"}}');
    assert.equal(bad.kind, 'REQUEST');
    assert.equal(bad.retryOtherAccount, false);

    assert.equal(classifyGraphSendError(503, 'oops').kind, 'TRANSIENT');
    assert.equal(classifyGraphSendError(401, '').kind, 'AUTH');
});

void test('parses Retry-After seconds and dates', () => {
    assert.equal(parseRetryAfterSeconds('30'), 30);
    assert.equal(parseRetryAfterSeconds(new Date(Date.now() + 60_000).toUTCString(), Date.now()) !== null, true);
    assert.equal(parseRetryAfterSeconds('nonsense'), null);
    assert.equal(parseRetryAfterSeconds(undefined), null);
});

void test('detects Mail.Send scope precisely', () => {
    assert.equal(hasMailSendScope('https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send'), true);
    assert.equal(hasMailSendScope('Mail.Send'), true);
    assert.equal(hasMailSendScope('https://graph.microsoft.com/Mail.Send.Shared'), false);
    assert.equal(hasMailSendScope('https://graph.microsoft.com/Mail.Read'), false);
    assert.equal(hasMailSendScope(undefined), false);
});

void test('request hash ignores key order and undefined values', () => {
    assert.equal(computeRequestHash({ a: 1, b: [1, { c: 2, d: undefined }] }), computeRequestHash({ b: [1, { c: 2 }], a: 1 }));
    assert.notEqual(computeRequestHash({ a: 1 }), computeRequestHash({ a: 2 }));
});

void test('sorts sender candidates by strategy', () => {
    const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
    const candidates = [
        { id: 1, sent24h: 5, lastSentAt: t(10) },
        { id: 2, sent24h: 1, lastSentAt: t(30) },
        { id: 3, sent24h: 1, lastSentAt: null },
    ];
    assert.deepEqual(sortSenderCandidates(candidates, 'LEAST_USED').map((c) => c.id), [3, 2, 1]);
    assert.deepEqual(sortSenderCandidates(candidates, 'ROUND_ROBIN').map((c) => c.id), [3, 1, 2]);
    const keys = [0.9, 0.1, 0.5];
    let i = 0;
    assert.deepEqual(sortSenderCandidates(candidates, 'RANDOM', () => keys[i++]).map((c) => c.id), [2, 3, 1]);
});
