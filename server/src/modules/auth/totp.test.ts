import assert from 'node:assert/strict';
import test from 'node:test';
import { generateBase32Secret, generateTotpCodeAt, verifyTotpCode, buildTotpUri } from './totp.js';

void test('generates valid base32 secret', () => {
    const secret = generateBase32Secret();
    assert.match(secret, /^[A-Z2-7]+$/);
    assert.ok(secret.length >= 16);
});

void test('verifies generated totp code at fixed timestamp', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const now = 1_700_000_000_000;
    const code = generateTotpCodeAt(secret, now);
    assert.match(code, /^\d{6}$/);
    assert.equal(verifyTotpCode(secret, code, 1, now), true);
});

void test('rejects invalid totp code', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const now = 1_700_000_000_000;
    const validCode = generateTotpCodeAt(secret, now);
    const invalidCode = validCode === '000000' ? '000001' : '000000';
    assert.equal(verifyTotpCode(secret, invalidCode, 0, now), false);
});

void test('builds otpauth uri with issuer and account', () => {
    const uri = buildTotpUri('JBSWY3DPEHPK3PXP', 'admin', 'GongXi Mail');
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
    assert.match(uri, /issuer=GongXi%20Mail/);
});
