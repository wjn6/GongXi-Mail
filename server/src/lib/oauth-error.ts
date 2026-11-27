/**
 * Microsoft OAuth 令牌错误解析与收信失败合并（纯函数，便于测试）。
 *
 * 同一个 refresh token 同时用于 Graph 和 IMAP 换取访问令牌：
 * 令牌失效、需要交互登录、未授权、客户端 ID 不对、账号不可用这类问题属于账号层面，
 * 两条路径会以同样的原因失败，单独给出明确的错误码，方便调用方判断“需要重新授权”。
 */

export type OAuthFailureKind =
    | 'TENANT_MISMATCH'
    | 'TOKEN_INVALID'
    | 'INTERACTION_REQUIRED'
    | 'CONSENT_REQUIRED'
    | 'CLIENT_INVALID'
    | 'ACCOUNT_UNAVAILABLE'
    | 'ACCOUNT_SUSPENDED'
    | 'NETWORK'
    | 'UNKNOWN';

export interface OAuthFailure {
    kind: OAuthFailureKind;
    /** HTTP 状态码；网络错误为 0 */
    status: number;
    /** OAuth error 字段，如 invalid_grant */
    error: string;
    /** AADSTS 错误码，如 AADSTS70000 */
    aadsts: string | null;
    /** 精简后的错误描述（去掉 Trace ID / Correlation ID / Timestamp） */
    description: string;
}

const TOKEN_INVALID_CODES = new Set(['70000', '70008', '700082', '700084', '50173']);
const INTERACTION_CODES = new Set(['50076', '50079', '50158', '53003']);
const CONSENT_CODES = new Set(['65001', '65004']);
const CLIENT_CODES = new Set(['700016', '7000218']);
/** 登录端点与应用支持的账号类型不一致（如只支持个人账号的应用请求了 /common） */
const TENANT_MISMATCH_CODES = new Set(['9002331', '50194', '9002346', '500207']);
const ACCOUNT_CODES = new Set(['50034', '50053', '50057']);
/**
 * 微软因疑似滥用（多为发信被判定为垃圾邮件）暂停了账号。微软仍返回 invalid_grant AADSTS70000，
 * 但描述为 "User account is found to be in service abuse mode."，重新授权无法解决，需要先登录解封。
 */
const ACCOUNT_SUSPENDED_RE = /service abuse mode|account (?:is |has been )?(?:temporarily )?suspended/i;

/** 账号层面的失败 → 对外错误码 */
export const ACCOUNT_LEVEL_ERROR_CODES: Record<Exclude<OAuthFailureKind, 'NETWORK' | 'UNKNOWN'>, string> = {
    TENANT_MISMATCH: 'OAUTH_ENDPOINT_MISMATCH',
    TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
    INTERACTION_REQUIRED: 'ACCOUNT_ACTION_REQUIRED',
    CONSENT_REQUIRED: 'CONSENT_REQUIRED',
    CLIENT_INVALID: 'CLIENT_ID_INVALID',
    ACCOUNT_UNAVAILABLE: 'MS_ACCOUNT_UNAVAILABLE',
    ACCOUNT_SUSPENDED: 'MS_ACCOUNT_SUSPENDED',
};

const ACCOUNT_LEVEL_HINTS: Record<keyof typeof ACCOUNT_LEVEL_ERROR_CODES, string> = {
    TENANT_MISMATCH: "The group's Microsoft login endpoint does not match the account types this client ID supports; change the group's login endpoint (personal-account apps must use /consumers)",
    TOKEN_INVALID: 'Refresh token is invalid, expired, revoked or does not match the client ID; re-authorize this account and update its refresh token',
    INTERACTION_REQUIRED: 'Microsoft requires an interactive sign-in for this account (MFA or security check)',
    CONSENT_REQUIRED: 'The app has not been granted the required permissions for this account; re-authorize it',
    CLIENT_INVALID: 'The client ID is wrong for this refresh token, or the app cannot be used with this account',
    ACCOUNT_UNAVAILABLE: 'The Microsoft account does not exist, is disabled or is locked',
    ACCOUNT_SUSPENDED: 'Microsoft has suspended this account for suspected abuse (usually outbound spam); sign in at outlook.live.com and complete the verification to unlock it, then refresh the token again (re-authorize only if it still fails)',
};

const ACCOUNT_LEVEL_CODE_SET = new Set(Object.values(ACCOUNT_LEVEL_ERROR_CODES));

export function isAccountLevelErrorCode(code: string): boolean {
    return ACCOUNT_LEVEL_CODE_SET.has(code);
}

function isAccountLevelKind(kind: OAuthFailureKind): kind is keyof typeof ACCOUNT_LEVEL_ERROR_CODES {
    return kind !== 'NETWORK' && kind !== 'UNKNOWN';
}

/** 是否为账号层面的失败（令牌失效、需要交互登录、未授权、客户端 ID 不对、账号不可用或被暂停） */
export function isAccountLevelOAuthFailure(failure: OAuthFailure): boolean {
    return isAccountLevelKind(failure.kind);
}

function cleanDescription(text: string): string {
    return text
        .replace(/\s*Trace ID:[\s\S]*$/i, '')
        .replace(/\s*Correlation ID:[\s\S]*$/i, '')
        .replace(/^AADSTS\d+:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

function classify(error: string, aadstsNumber: string | null, description: string): OAuthFailureKind {
    if (ACCOUNT_SUSPENDED_RE.test(description)) return 'ACCOUNT_SUSPENDED';
    if (aadstsNumber) {
        if (TENANT_MISMATCH_CODES.has(aadstsNumber)) return 'TENANT_MISMATCH';
        if (INTERACTION_CODES.has(aadstsNumber)) return 'INTERACTION_REQUIRED';
        if (CONSENT_CODES.has(aadstsNumber)) return 'CONSENT_REQUIRED';
        if (CLIENT_CODES.has(aadstsNumber)) return 'CLIENT_INVALID';
        if (ACCOUNT_CODES.has(aadstsNumber)) return 'ACCOUNT_UNAVAILABLE';
        if (TOKEN_INVALID_CODES.has(aadstsNumber)) return 'TOKEN_INVALID';
    }
    switch (error) {
        case 'interaction_required':
            return 'INTERACTION_REQUIRED';
        case 'consent_required':
            return 'CONSENT_REQUIRED';
        case 'unauthorized_client':
        case 'invalid_client':
            return 'CLIENT_INVALID';
        case 'invalid_grant':
            return 'TOKEN_INVALID';
        default:
            return 'UNKNOWN';
    }
}

/**
 * 解析令牌接口（/oauth2/v2.0/token）的错误响应。
 */
export function parseOAuthTokenError(status: number, bodyText: string): OAuthFailure {
    let error = '';
    let rawDescription = '';
    let codes: unknown[] = [];
    try {
        const parsed = JSON.parse(bodyText) as { error?: unknown; error_description?: unknown; error_codes?: unknown };
        error = typeof parsed.error === 'string' ? parsed.error : '';
        rawDescription = typeof parsed.error_description === 'string' ? parsed.error_description : '';
        codes = Array.isArray(parsed.error_codes) ? parsed.error_codes : [];
    } catch {
        rawDescription = (bodyText || '').slice(0, 300);
    }

    const fromDescription = /AADSTS(\d+)/i.exec(rawDescription)?.[1] ?? null;
    const fromCodes = codes.length > 0 && Number.isFinite(Number(codes[0])) ? String(codes[0]) : null;
    const aadstsNumber = fromDescription ?? fromCodes;

    return {
        kind: classify(error, aadstsNumber, rawDescription),
        status,
        error: error || `http_${status}`,
        aadsts: aadstsNumber ? `AADSTS${aadstsNumber}` : null,
        description: cleanDescription(rawDescription) || `HTTP ${status}`,
    };
}

export function networkOAuthFailure(message: string): OAuthFailure {
    return {
        kind: 'NETWORK',
        status: 0,
        error: 'network_error',
        aadsts: null,
        description: cleanDescription(message) || 'Network error',
    };
}

export function unknownOAuthFailure(message: string, status = 200): OAuthFailure {
    return { kind: 'UNKNOWN', status, error: 'unexpected_response', aadsts: null, description: message };
}

/** 例如 "invalid_grant AADSTS70000: The provided value ... is not valid." */
export function describeOAuthFailure(failure: OAuthFailure): string {
    if (failure.kind === 'NETWORK') {
        return `network error: ${failure.description}`;
    }
    const head = [failure.error, failure.aadsts].filter(Boolean).join(' ');
    return `${head}: ${failure.description}`;
}

/** 账号层面的失败带上处理建议，其它情况只给原因 */
export function formatOAuthFailure(failure: OAuthFailure): string {
    if (isAccountLevelKind(failure.kind)) {
        return `${ACCOUNT_LEVEL_HINTS[failure.kind]} (${describeOAuthFailure(failure)})`;
    }
    return describeOAuthFailure(failure);
}

// ============================================================
// 收信失败
// ============================================================

export type FetchMethod = 'graph' | 'imap';

export interface FetchFailure {
    method: FetchMethod;
    code: string;
    message: string;
    statusCode: number;
}

export interface CombinedFetchFailure {
    code: string;
    message: string;
    statusCode: number;
    details: { attempts: Array<{ method: FetchMethod; code: string; message: string }> };
}

const METHOD_LABELS: Record<FetchMethod, string> = { graph: 'Graph', imap: 'IMAP' };

/**
 * 换取访问令牌失败 → 收信错误。账号层面的问题使用专门的错误码。
 */
export function tokenFailureToFetchFailure(
    method: FetchMethod,
    failure: OAuthFailure,
    fallback: { code: string; statusCode: number } = {
        code: method === 'graph' ? 'GRAPH_TOKEN_FAILED' : 'IMAP_TOKEN_FAILED',
        statusCode: 502,
    }
): FetchFailure {
    if (isAccountLevelKind(failure.kind)) {
        return {
            method,
            code: ACCOUNT_LEVEL_ERROR_CODES[failure.kind],
            message: formatOAuthFailure(failure),
            statusCode: 502,
        };
    }
    return {
        method,
        code: fallback.code,
        message: `Failed to get ${METHOD_LABELS[method]} access token: ${describeOAuthFailure(failure)}`,
        statusCode: fallback.statusCode,
    };
}

function isAppErrorLike(err: unknown): err is { code: string; message: string; statusCode: number } {
    if (!err || typeof err !== 'object') return false;
    const value = err as { code?: unknown; message?: unknown; statusCode?: unknown };
    return typeof value.code === 'string' && typeof value.message === 'string' && typeof value.statusCode === 'number';
}

/**
 * 任意错误 → 收信错误。已有错误码的保留；其它错误（Graph 接口报错、IMAP 连接失败等）
 * 归为 GRAPH_FETCH_FAILED / IMAP_FETCH_FAILED，避免变成笼统的 500 Internal server error。
 */
export function fetchFailureFromError(method: FetchMethod, err: unknown): FetchFailure {
    if (isAppErrorLike(err)) {
        return { method, code: err.code, message: err.message, statusCode: err.statusCode };
    }
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
    return {
        method,
        code: method === 'graph' ? 'GRAPH_FETCH_FAILED' : 'IMAP_FETCH_FAILED',
        message: `${METHOD_LABELS[method]} request failed: ${raw.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Unknown error'}`,
        statusCode: 502,
    };
}

/**
 * 主路径失败、回退路径也失败时合并成一个错误：
 * - 两边是同一个账号层面的原因：只报这个原因（例如 refresh token 失效）
 * - 有一边是账号层面的原因：以它为准，同时附上另一边的原因
 * - 否则以主路径为准，附上回退路径的原因
 * details.attempts 按顺序列出两条路径各自的错误。
 */
export function combineFetchFailures(primary: FetchFailure, fallback: FetchFailure): CombinedFetchFailure {
    const attempts = [primary, fallback].map(({ method, code, message }) => ({ method, code, message }));
    const details = { attempts };
    const both = `${METHOD_LABELS[primary.method]} and ${METHOD_LABELS[fallback.method]} both failed`;

    if (primary.code === fallback.code && isAccountLevelErrorCode(primary.code)) {
        return { code: primary.code, message: `${primary.message} [${both}]`, statusCode: primary.statusCode, details };
    }

    const lead = !isAccountLevelErrorCode(primary.code) && isAccountLevelErrorCode(fallback.code) ? fallback : primary;
    const other = lead === primary ? fallback : primary;
    return {
        code: lead.code,
        message: `${METHOD_LABELS[lead.method]}: ${lead.message}; ${METHOD_LABELS[other.method]}: ${other.message} [${both}]`,
        statusCode: lead.statusCode,
        details,
    };
}
