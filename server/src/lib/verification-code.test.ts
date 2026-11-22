import assert from 'node:assert/strict';
import test from 'node:test';
import {
    extractVerificationCode,
    getMessageMatchText,
    htmlToPlainText,
    matchWithUserRegex,
} from './verification-code.js';

void test('extracts codes near keywords in subject or body', () => {
    assert.equal(extractVerificationCode('Your Microsoft account security code', 'Security code: 482913'), '482913');
    assert.equal(extractVerificationCode('123456 is your Discord code', ''), '123456');
    assert.equal(extractVerificationCode('验证码通知', '您的验证码是 7788，5分钟内有效'), '7788');
    assert.equal(
        extractVerificationCode('AWS', 'Verification code:\n\n  905217\n\nExpires in 10 minutes'),
        '905217'
    );
});

void test('ignores numbers without code context', () => {
    assert.equal(extractVerificationCode('Newsletter 2026', 'Order 20261123 shipped in 2026'), null);
    assert.equal(extractVerificationCode('Welcome', 'Thanks for joining, call 4008123123'), null);
    assert.equal(extractVerificationCode('Your code', 'code: 000000'), null);
});

void test('converts html to plain text for matching', () => {
    assert.equal(
        htmlToPlainText('<style>x{}</style><div>Hello&nbsp;<b>World</b></div><p>Line2</p>'),
        'Hello World\nLine2'
    );
    assert.equal(getMessageMatchText('preview only', '<p>您的验证码是 <b>246810</b></p>'), '您的验证码是 246810');
    assert.equal(getMessageMatchText('plain body', ''), 'plain body');
});

void test('user regex prefers first capture group and checks subject first', () => {
    assert.equal(matchWithUserRegex(/code[：:]\s*(\d{6})/i, '', 'Code: 135790'), '135790');
    assert.equal(matchWithUserRegex(/\d{6}/, 'G-112233 is your code', 'other 445566'), '112233');
    assert.equal(matchWithUserRegex(/\d{8}/, 'none', 'none'), null);
});
