import assert from 'node:assert/strict';
import test from 'node:test';
import { isApiPermissionAllowed } from './api-permissions.js';

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
