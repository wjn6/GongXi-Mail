import assert from 'node:assert/strict';
import test from 'node:test';
import {
    combineFetchFailures,
    describeOAuthFailure,
    fetchFailureFromError,
    formatOAuthFailure,
    networkOAuthFailure,
    parseOAuthTokenError,
    tokenFailureToFetchFailure,
    type FetchFailure,
} from './oauth-error.js';

// 线上日志中微软返回的原文（AADSTS70000）
const INVALID_GRANT_BODY = JSON.stringify({
    error: 'invalid_grant',
    error_description: "AADSTS70000: The provided value for the input parameter 'refresh_token' or 'assertion' is not valid. Trace ID: 7164c80b-8805-4e64-80b7-018125fa5200 Correlation ID: 6fa6b142-a87d-4b45-980e-10721be9d936 Timestamp: 2026-11-27 12:24:44Z",
    error_codes: [70000],
    timestamp: '2026-11-27 12:24:44Z',
    trace_id: '7164c80b-8805-4e64-80b7-018125fa5200',
    correlation_id: '6fa6b142-a87d-4b45-980e-10721be9d936',
    error_uri: 'https://login.microsoftonline.com/error?code=[REDACTED_PARAM]',
});

const body = (error: string, code: number, text: string) => JSON.stringify({
    error,
    error_description: `AADSTS${code}: ${text} Trace ID: x Correlation ID: y Timestamp: z`,
    error_codes: [code],
});

void test('parses invalid_grant AADSTS70000 and strips trace noise', () => {
    const failure = parseOAuthTokenError(400, INVALID_GRANT_BODY);
    assert.equal(failure.kind, 'TOKEN_INVALID');
    assert.equal(failure.error, 'invalid_grant');
    assert.equal(failure.aadsts, 'AADSTS70000');
    assert.equal(failure.description, "The provided value for the input parameter 'refresh_token' or 'assertion' is not valid.");
    assert.equal(
        describeOAuthFailure(failure),
        "invalid_grant AADSTS70000: The provided value for the input parameter 'refresh_token' or 'assertion' is not valid."
    );
    assert.match(formatOAuthFailure(failure), /^Refresh token is invalid, expired, revoked/);
    assert.doesNotMatch(formatOAuthFailure(failure), /Trace ID|Correlation ID/);
});

void test('classifies account-level AADSTS codes', () => {
    assert.equal(parseOAuthTokenError(400, body('invalid_grant', 50076, 'MFA required.')).kind, 'INTERACTION_REQUIRED');
    assert.equal(parseOAuthTokenError(400, body('interaction_required', 53003, 'Blocked by CA.')).kind, 'INTERACTION_REQUIRED');
    assert.equal(parseOAuthTokenError(400, body('invalid_grant', 65001, 'No consent.')).kind, 'CONSENT_REQUIRED');
    assert.equal(parseOAuthTokenError(400, body('unauthorized_client', 700016, 'App not found.')).kind, 'CLIENT_INVALID');
    assert.equal(parseOAuthTokenError(400, body('invalid_grant', 50057, 'Disabled.')).kind, 'ACCOUNT_UNAVAILABLE');
    assert.equal(parseOAuthTokenError(400, body('invalid_grant', 700082, 'Expired due to inactivity.')).kind, 'TOKEN_INVALID');
    assert.equal(parseOAuthTokenError(400, body('invalid_request', 9002313, 'Malformed.')).kind, 'UNKNOWN');
});

void test('recognizes accounts suspended for abuse despite AADSTS70000', () => {
    const failure = parseOAuthTokenError(400, body('invalid_grant', 70000, 'User account is found to be in service abuse mode.'));
    assert.equal(failure.kind, 'ACCOUNT_SUSPENDED');
    assert.equal(failure.aadsts, 'AADSTS70000');
    assert.match(formatOAuthFailure(failure), /^Microsoft has suspended this account/);
    assert.match(formatOAuthFailure(failure), /service abuse mode/);
    assert.equal(tokenFailureToFetchFailure('graph', failure).code, 'MS_ACCOUNT_SUSPENDED');
});

void test('handles non-JSON responses and network errors', () => {
    const html = parseOAuthTokenError(503, '<html>Service Unavailable</html>');
    assert.equal(html.kind, 'UNKNOWN');
    assert.equal(html.error, 'http_503');
    assert.equal(describeOAuthFailure(html), 'http_503: <html>Service Unavailable</html>');

    const net = networkOAuthFailure('connect ETIMEDOUT 40.126.0.1:443');
    assert.equal(describeOAuthFailure(net), 'network error: connect ETIMEDOUT 40.126.0.1:443');
});

void test('token failures map to account-level codes or path-specific codes', () => {
    const invalid = tokenFailureToFetchFailure('imap', parseOAuthTokenError(400, INVALID_GRANT_BODY));
    assert.equal(invalid.code, 'REFRESH_TOKEN_INVALID');
    assert.equal(invalid.statusCode, 502);
    assert.match(invalid.message, /AADSTS70000/);

    const network = tokenFailureToFetchFailure('imap', networkOAuthFailure('socket hang up'));
    assert.equal(network.code, 'IMAP_TOKEN_FAILED');
    assert.equal(network.message, 'Failed to get IMAP access token: network error: socket hang up');

    const mailbox = tokenFailureToFetchFailure('graph', networkOAuthFailure('x'), { code: 'GRAPH_API_FAILED', statusCode: 500 });
    assert.equal(mailbox.code, 'GRAPH_API_FAILED');
    assert.equal(mailbox.statusCode, 500);
});

void test('wraps plain errors instead of leaking as internal errors', () => {
    const graph = fetchFailureFromError('graph', new Error('Graph API error: 401 - {"error":{"code":"InvalidAuthenticationToken"}}'));
    assert.equal(graph.code, 'GRAPH_FETCH_FAILED');
    assert.equal(graph.statusCode, 502);
    assert.match(graph.message, /^Graph request failed: Graph API error: 401/);

    const kept = fetchFailureFromError('imap', { code: 'IMAP_TOKEN_FAILED', message: 'm', statusCode: 502 });
    assert.deepEqual(kept, { method: 'imap', code: 'IMAP_TOKEN_FAILED', message: 'm', statusCode: 502 });

    assert.equal(fetchFailureFromError('imap', 'boom').message, 'IMAP request failed: boom');
});

void test('combines both failures without hiding the primary reason', () => {
    const invalid = parseOAuthTokenError(400, INVALID_GRANT_BODY);
    const graphInvalid = tokenFailureToFetchFailure('graph', invalid);
    const imapInvalid = tokenFailureToFetchFailure('imap', invalid);

    // 两边同一个账号层面的原因：只报这个原因
    const same = combineFetchFailures(graphInvalid, imapInvalid);
    assert.equal(same.code, 'REFRESH_TOKEN_INVALID');
    assert.match(same.message, /Graph and IMAP both failed/);
    assert.equal(same.details.attempts.length, 2);
    assert.deepEqual(same.details.attempts.map((a) => a.method), ['graph', 'imap']);

    // 主路径普通错误、回退路径账号层面错误：以账号层面为准
    const scope: FetchFailure = { method: 'graph', code: 'GRAPH_SCOPE_MISSING', message: 'Graph token missing Mail.Read scope', statusCode: 502 };
    const mixed = combineFetchFailures(scope, imapInvalid);
    assert.equal(mixed.code, 'REFRESH_TOKEN_INVALID');
    assert.match(mixed.message, /^IMAP: Refresh token is invalid.*; Graph: Graph token missing Mail\.Read scope/);

    // 都是普通错误：以主路径为准，附上回退路径
    const imapNet = tokenFailureToFetchFailure('imap', networkOAuthFailure('timeout'));
    const plain = combineFetchFailures(scope, imapNet);
    assert.equal(plain.code, 'GRAPH_SCOPE_MISSING');
    assert.equal(
        plain.message,
        'Graph: Graph token missing Mail.Read scope; IMAP: Failed to get IMAP access token: network error: timeout [Graph and IMAP both failed]'
    );
});
