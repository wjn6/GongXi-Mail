import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOAuthTenant, tokenEndpointFor } from './oauth-tenant.js';
import { formatOAuthFailure, isAccountLevelOAuthFailure, parseOAuthTokenError } from './oauth-error.js';

void test('maps group tenant to the Microsoft token endpoint', () => {
    assert.equal(tokenEndpointFor('CONSUMERS'), 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    assert.equal(tokenEndpointFor('ORGANIZATIONS'), 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
    assert.equal(tokenEndpointFor('COMMON'), 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
});

void test('defaults to consumers for ungrouped or unknown values', () => {
    for (const value of [undefined, null, '', 'consumers', 'tenant-id', 42]) {
        assert.equal(normalizeOAuthTenant(value), 'CONSUMERS');
        assert.equal(tokenEndpointFor(value), 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    }
});

void test('wrong endpoint for a consumers-only app is reported as a client problem', () => {
    // 线上原文：应用只支持个人账号却请求了 /common
    const failure = parseOAuthTokenError(400, JSON.stringify({
        error: 'invalid_request',
        error_description: "AADSTS9002331: Application '229ef870-f0ec-40fe-9499-bc3a03560916'(邮件) is configured for use by Microsoft Account users only. Please use the /consumers endpoint to serve this request. Trace ID: x Correlation ID: y Timestamp: z",
        error_codes: [9002331],
    }));
    assert.equal(failure.aadsts, 'AADSTS9002331');
    assert.equal(failure.kind, 'TENANT_MISMATCH');
    assert.equal(isAccountLevelOAuthFailure(failure), true);
    assert.match(formatOAuthFailure(failure), /change the group's login endpoint/);
    assert.match(formatOAuthFailure(failure), /Please use the \/consumers endpoint/);
});

void test('network failures are not account level', () => {
    const failure = parseOAuthTokenError(503, 'Service Unavailable');
    assert.equal(isAccountLevelOAuthFailure(failure), false);
});
