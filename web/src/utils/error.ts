/** 账号层面的错误：在原文前加上中文处理建议 */
const ERROR_CODE_HINTS: Record<string, string> = {
    OAUTH_ENDPOINT_MISMATCH: '分组的「微软登录端点」与客户端 ID 支持的账号类型不一致，请在邮箱分组中修改（只支持个人账号的应用要选 /consumers）',
    REFRESH_TOKEN_INVALID: '刷新令牌已失效（过期、被吊销或与客户端 ID 不匹配），请重新授权该邮箱并更新刷新令牌',
    ACCOUNT_ACTION_REQUIRED: '微软要求该账号先登录完成验证（如二次验证、安全检查）',
    CONSENT_REQUIRED: '应用未获得该账号的授权，请重新授权',
    CLIENT_ID_INVALID: '客户端 ID 无效，或不能用于该账号',
    MS_ACCOUNT_UNAVAILABLE: '微软账号不存在、已被禁用或被锁定',
};

export function getErrorMessage(error: unknown, fallback: string): string {
    if (!error || typeof error !== 'object') {
        return fallback;
    }

    const payload = error as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
        requestId?: unknown;
    };
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const code = payload.code;
    const codeText = typeof code === 'string' || typeof code === 'number' ? String(code) : '';

    const detailText = Array.isArray(payload.details)
        ? payload.details
            .slice(0, 3)
            .map((detail) => {
                if (!detail || typeof detail !== 'object') {
                    return '';
                }
                const item = detail as { path?: unknown; message?: unknown };
                const path = Array.isArray(item.path) ? item.path.map(String).join('.') : '';
                const detailMessage = typeof item.message === 'string' ? item.message : '';
                if (path && detailMessage) {
                    return `${path}: ${detailMessage}`;
                }
                return detailMessage || path;
            })
            .filter(Boolean)
            .join('; ')
        : '';

    const baseMessage = detailText
        ? `${message || fallback}: ${detailText}`
        : (message || fallback);
    const hint = codeText ? ERROR_CODE_HINTS[codeText] : undefined;
    const finalMessage = hint ? `${hint}：${baseMessage}` : baseMessage;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const hasRequestIdText = finalMessage.includes('requestId:');
    const withRequestId = requestId && !hasRequestIdText ? `${finalMessage} (requestId: ${requestId})` : finalMessage;

    if (!codeText) {
        return withRequestId;
    }

    return `[${codeText}] ${withRequestId}`;
}
