import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ResendApiError,
    formatResendTimestamp,
    parseBatchValidationMode,
    parseListQuery,
    parseResendEmailPayload,
    toResendEmailObject,
    toResendError,
    toResendListItem,
    validateIdempotencyKey,
} from './resend-compat.js';
import { SendRequestError } from './send-mail.js';
import { isPublicIpAddress } from './remote-attachment.js';

function expectResendError(fn: () => unknown, statusCode: number, name: string) {
    try {
        fn();
    } catch (err) {
        assert.ok(err instanceof ResendApiError, `expected ResendApiError, got ${String(err)}`);
        assert.equal(err.statusCode, statusCode);
        assert.equal(err.errorName, name);
        return err;
    }
    assert.fail('expected an error');
}

void test('parses a Resend email payload with snake_case fields', () => {
    const parsed = parseResendEmailPayload({
        from: 'Acme <onboarding@acme.dev>',
        to: ['delivered@resend.dev'],
        subject: 'hello world',
        html: '<p>it works!</p>',
        reply_to: 'reply@acme.dev',
        tags: [{ name: 'category', value: 'confirm_email' }],
        attachments: [{ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain', content_id: 'logo' }],
    }, { batch: false });
    assert.equal(parsed.from.address, 'onboarding@acme.dev');
    assert.equal(parsed.sendInput.fromName, 'Acme');
    assert.equal(parsed.sendInput.replyTo, 'reply@acme.dev');
    assert.deepEqual(parsed.tags, [{ name: 'category', value: 'confirm_email' }]);
    assert.deepEqual(parsed.sendInput.attachments, [{ filename: 'a.txt', content: 'aGk=', path: undefined, contentType: 'text/plain', contentId: 'logo' }]);
});

void test('rejects unsupported and invalid Resend fields explicitly', () => {
    const base = { from: 'a@x.com', to: 'b@x.com', subject: 's', text: 't' };
    expectResendError(() => parseResendEmailPayload({ ...base, scheduled_at: 'in 1 min' }, { batch: false }), 422, 'validation_error');
    expectResendError(() => parseResendEmailPayload({ ...base, template: { id: 'x' } }, { batch: false }), 422, 'validation_error');
    expectResendError(() => parseResendEmailPayload({ ...base, from: undefined }, { batch: false }), 422, 'missing_required_field');
    expectResendError(() => parseResendEmailPayload({ ...base, from: 'nope' }, { batch: false }), 422, 'invalid_from_address');
    expectResendError(() => parseResendEmailPayload({ ...base, tags: [{ name: 'bad name', value: 'x' }] }, { batch: false }), 422, 'validation_error');
    expectResendError(() => parseResendEmailPayload({ ...base, attachments: [{ filename: 'a' }] }, { batch: false }), 422, 'invalid_attachment');
    expectResendError(() => parseResendEmailPayload({ ...base, attachments: [{ path: 'http://x.com/a.pdf' }] }, { batch: false }), 422, 'invalid_attachment');
    expectResendError(() => parseResendEmailPayload({ ...base, attachments: [{ filename: 'a', content: 'aGk=' }] }, { batch: true }), 422, 'validation_error');
    expectResendError(() => parseResendEmailPayload([], { batch: false }), 422, 'validation_error');
});

void test('maps send request errors to Resend error names', () => {
    assert.equal(toResendError(new SendRequestError('MISSING_FIELD', 'Missing `to` field.')).errorName, 'missing_required_field');
    assert.equal(toResendError(new SendRequestError('INVALID_ATTACHMENT', 'x')).errorName, 'invalid_attachment');
    assert.equal(toResendError(new SendRequestError('INVALID_HEADER', 'x')).errorName, 'validation_error');
    assert.deepEqual(new ResendApiError(429, 'rate_limit_exceeded', 'slow').toBody(), {
        statusCode: 429, name: 'rate_limit_exceeded', message: 'slow',
    });
});

void test('validates idempotency key, batch mode and list query', () => {
    assert.equal(validateIdempotencyKey(undefined), undefined);
    assert.equal(validateIdempotencyKey('welcome-user/123'), 'welcome-user/123');
    expectResendError(() => validateIdempotencyKey(''), 400, 'invalid_idempotency_key');
    expectResendError(() => validateIdempotencyKey('x'.repeat(257)), 400, 'invalid_idempotency_key');

    assert.equal(parseBatchValidationMode(undefined), 'strict');
    assert.equal(parseBatchValidationMode('Permissive'), 'permissive');
    expectResendError(() => parseBatchValidationMode('loose'), 422, 'validation_error');

    assert.deepEqual(parseListQuery({}), { limit: 20, after: undefined, before: undefined });
    assert.equal(parseListQuery({ limit: '100' }).limit, 100);
    expectResendError(() => parseListQuery({ limit: '101' }), 422, 'validation_error');
    expectResendError(() => parseListQuery({ after: 'x' }), 422, 'invalid_parameter');
    const id = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c';
    expectResendError(() => parseListQuery({ after: id, before: id }), 422, 'validation_error');
});

void test('formats sent email objects like Resend', () => {
    const row = {
        id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
        status: 'SENT' as const,
        requestedFrom: 'Acme <onboarding@acme.dev>',
        fromName: 'Acme',
        fromAddress: 'pool1@outlook.com',
        toAddresses: [{ address: 'delivered@resend.dev' }],
        ccAddresses: null,
        bccAddresses: null,
        replyTo: [{ address: 'r@acme.dev', name: 'Support' }],
        subject: 'Hello World',
        html: '<b>hi</b>',
        text: null,
        tags: [{ name: 'category', value: 'confirm_email' }],
        createdAt: new Date('2026-04-03T22:13:42.674Z'),
    };
    const email = toResendEmailObject(row);
    assert.equal(email.object, 'email');
    assert.equal(email.from, 'Acme <pool1@outlook.com>');
    assert.deepEqual(email.to, ['delivered@resend.dev']);
    assert.deepEqual(email.reply_to, ['Support <r@acme.dev>']);
    assert.deepEqual(email.cc, []);
    assert.equal(email.last_event, 'sent');
    assert.equal(email.created_at, '2026-04-03 22:13:42.674000+00');
    assert.equal(email.scheduled_at, null);

    const item = toResendListItem({ ...row, status: 'QUEUED', fromAddress: null });
    assert.equal('html' in item, false);
    assert.equal('object' in item, false);
    assert.equal(item.last_event, 'queued');
    assert.equal(item.from, 'Acme <onboarding@acme.dev>');
    assert.equal(formatResendTimestamp(null), null);
});

void test('blocks private and reserved addresses for remote attachments', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
        '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1']) {
        assert.equal(isPublicIpAddress(ip), false, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
        assert.equal(isPublicIpAddress(ip), true, ip);
    }
    assert.equal(isPublicIpAddress('not-an-ip'), false);
});
