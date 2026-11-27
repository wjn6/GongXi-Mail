import assert from 'node:assert/strict';
import test from 'node:test';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { normalizeSendRequest } from './send-mail.js';
import {
    buildSmtpMessage,
    classifySmtpSendError,
    effectiveSendCapability,
    hasSmtpSendScope,
    normalizeSendTransport,
    resolveChannelOrder,
    shouldTryNextChannel,
    smtpHostFor,
} from './smtp-send.js';

void test('normalizes send transport and picks SMTP host by tenant', () => {
    assert.equal(normalizeSendTransport('SMTP'), 'SMTP');
    assert.equal(normalizeSendTransport('GRAPH'), 'GRAPH');
    assert.equal(normalizeSendTransport(undefined), 'AUTO');
    assert.equal(normalizeSendTransport('bogus'), 'AUTO');
    assert.equal(smtpHostFor('CONSUMERS'), 'smtp-mail.outlook.com');
    assert.equal(smtpHostFor(null), 'smtp-mail.outlook.com');
    assert.equal(smtpHostFor('ORGANIZATIONS'), 'smtp.office365.com');
});

void test('detects SMTP.Send scope', () => {
    assert.equal(hasSmtpSendScope('https://outlook.office.com/SMTP.Send https://outlook.office.com/Mail.Read'), true);
    assert.equal(hasSmtpSendScope('https://outlook.office.com/IMAP.AccessAsUser.All'), false);
    assert.equal(hasSmtpSendScope(''), false);
});

void test('effective capability follows the group transport', () => {
    assert.equal(effectiveSendCapability('GRAPH', 'DENIED', 'ALLOWED'), 'DENIED');
    assert.equal(effectiveSendCapability('SMTP', 'DENIED', 'ALLOWED'), 'ALLOWED');
    assert.equal(effectiveSendCapability('AUTO', 'DENIED', 'ALLOWED'), 'ALLOWED');
    assert.equal(effectiveSendCapability('AUTO', 'DENIED', 'UNKNOWN'), 'UNKNOWN');
    assert.equal(effectiveSendCapability('AUTO', 'DENIED', 'DENIED'), 'DENIED');
    assert.equal(effectiveSendCapability(null, undefined, undefined), 'UNKNOWN');
});

void test('channel order: AUTO prefers SMTP only when a sender name is set', () => {
    const unknown = { graph: 'UNKNOWN' as const, smtp: 'UNKNOWN' as const };
    assert.deepEqual(resolveChannelOrder('AUTO', true, unknown), ['SMTP', 'GRAPH']);
    assert.deepEqual(resolveChannelOrder('AUTO', false, unknown), ['GRAPH', 'SMTP']);
    assert.deepEqual(resolveChannelOrder('GRAPH', true, unknown), ['GRAPH']);
    assert.deepEqual(resolveChannelOrder('SMTP', false, { graph: 'ALLOWED', smtp: 'DENIED' }), ['SMTP']);
    // AUTO skips channels known to be unavailable, but never returns an empty list
    assert.deepEqual(resolveChannelOrder('AUTO', true, { graph: 'ALLOWED', smtp: 'DENIED' }), ['GRAPH']);
    assert.deepEqual(resolveChannelOrder('AUTO', false, { graph: 'DENIED', smtp: 'DENIED' }), ['GRAPH']);
});

void test('classifies SMTP errors', () => {
    const disabled = classifySmtpSendError({
        code: 'EAUTH', responseCode: 535, command: 'AUTH XOAUTH2',
        response: '535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox.',
    });
    assert.equal(disabled.kind, 'PERMISSION');
    assert.equal(disabled.markDenied, true);
    assert.equal(disabled.graphCode, 'SMTP_535_5.7.139');

    const auth = classifySmtpSendError({ code: 'EAUTH', responseCode: 535, response: '535 5.7.3 Authentication unsuccessful' });
    assert.equal(auth.kind, 'AUTH');
    assert.equal(auth.markDenied, false);
    assert.ok(auth.cooldownSeconds > 0);

    const spam = classifySmtpSendError({
        code: 'EMESSAGE', responseCode: 554,
        response: '554 5.2.0 STOREDRV.Submission.Exception:OutboundSpamException; Failed to process message due to a permanent exception',
    });
    assert.equal(spam.kind, 'BLOCKED');

    const throttled = classifySmtpSendError({ responseCode: 432, response: '432 4.3.2 STOREDRV.ClientSubmit; sender thread limit exceeded' });
    assert.equal(throttled.kind, 'THROTTLED');

    const recipient = classifySmtpSendError({ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 Recipient address rejected' });
    assert.equal(recipient.kind, 'REQUEST');
    assert.equal(recipient.retryOtherAccount, false);

    const network = classifySmtpSendError({ code: 'ECONNECTION', command: 'CONN', message: 'connect ETIMEDOUT 1.2.3.4:587' });
    assert.equal(network.kind, 'TRANSIENT');
    assert.equal(network.retryOtherAccount, true);
    assert.equal(shouldTryNextChannel(network), true);

    // connection lost during DATA: the message may already be accepted, so do not resend elsewhere
    const ambiguous = classifySmtpSendError({ code: 'ESOCKET', command: 'DATA', message: 'Connection closed' });
    assert.equal(ambiguous.kind, 'TRANSIENT');
    assert.equal(ambiguous.retryOtherAccount, false);
    assert.equal(shouldTryNextChannel(ambiguous), false);

    assert.equal(shouldTryNextChannel(disabled), true);
    assert.equal(shouldTryNextChannel(spam), false);
    assert.equal(shouldTryNextChannel(recipient), false);
});

void test('builds an SMTP message that keeps the sender name and hides bcc', async () => {
    const request = normalizeSendRequest({
        to: ['Bob <bob@example.com>'],
        cc: 'carol@example.com',
        bcc: 'secret@example.com',
        replyTo: 'support@acme.dev',
        subject: 'Hello',
        html: '<p>Hi <img src="cid:logo"></p>',
        text: 'Hi',
        fromName: '测试 Acme',
        headers: { 'X-Campaign': 'c1' },
        attachments: [
            { filename: 'a.txt', content: Buffer.from('hello').toString('base64') },
            { filename: 'logo.png', content: Buffer.from('png').toString('base64'), contentId: 'logo' },
        ],
    });
    const message = buildSmtpMessage(request, 'sender@outlook.com');
    assert.deepEqual(message.from, { name: '测试 Acme', address: 'sender@outlook.com' });
    assert.equal(message.disableFileAccess, true);
    assert.equal(message.disableUrlAccess, true);

    // SMTP 传输与 MailComposer 一样不保留 Bcc 头（只进信封）
    const node = new MailComposer(message).compile();
    const raw = (await node.build()).toString('utf8').replace(/\r\n/g, '\n');
    const headerBlock = raw.split('\n\n')[0];
    assert.match(headerBlock, /^From: =\?UTF-8\?[BQ]\?.+\?= <sender@outlook\.com>$/m);
    assert.match(headerBlock, /^To: Bob <bob@example\.com>$/m);
    assert.match(headerBlock, /^Cc: carol@example\.com$/m);
    assert.match(headerBlock, /^Reply-To: support@acme\.dev$/m);
    assert.match(headerBlock, /^X-Campaign: c1$/m);
    assert.doesNotMatch(headerBlock, /secret@example\.com/);
    assert.match(raw, /multipart\/alternative/);
    assert.match(raw, /Content-ID: <logo>/);
    assert.deepEqual(node.getEnvelope(), {
        from: 'sender@outlook.com',
        to: ['bob@example.com', 'carol@example.com', 'secret@example.com'],
    });

    const plain = buildSmtpMessage(normalizeSendRequest({ to: 'x@y.com', subject: 's', text: 't' }), 'sender@outlook.com');
    assert.equal(plain.from, 'sender@outlook.com');
    assert.equal(plain.html, undefined);
    assert.equal(plain.cc, undefined);
});
