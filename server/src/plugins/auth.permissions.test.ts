import assert from 'node:assert/strict';
import test from 'node:test';
import { isApiPermissionAllowed, parseApiPermissions } from './api-permissions.js';

void test('allows all actions when permissions not set', () => {
    assert.equal(isApiPermissionAllowed(undefined, 'mail_new'), true);
});

void test('supports wildcard allow', () => {
    assert.equal(isApiPermissionAllowed({ '*': true }, 'pool_stats'), true);
});

void test('allows explicit configured action', () => {
    assert.equal(isApiPermissionAllowed({ mail_new: true }, 'mail_new'), true);
});

void test('denies missing action when permission map present', () => {
    assert.equal(isApiPermissionAllowed({ mail_new: true }, 'mail_all'), false);
});

void test('normalizes kebab-case action keys', () => {
    assert.equal(isApiPermissionAllowed({ 'process-mailbox': true }, 'process_mailbox'), true);
});

void test('send actions require explicit permission', () => {
    assert.equal(isApiPermissionAllowed(undefined, 'send_mail'), false);
    assert.equal(isApiPermissionAllowed({}, 'send_read'), false);
    assert.equal(isApiPermissionAllowed({ mail_new: true }, 'send_mail'), false);
    assert.equal(isApiPermissionAllowed({ send_mail: true }, 'send_mail'), true);
    assert.equal(isApiPermissionAllowed({ send_mail: true }, 'send_read'), false);
    assert.equal(isApiPermissionAllowed({ '*': true }, 'send_mail'), true);
});

void test('drops unknown permission keys when parsing', () => {
    const parsed = parseApiPermissions({
        mail_new: true,
        unknown_action: true,
    });
    assert.deepEqual(parsed, { mail_new: true });
});
