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

    const finalMessage = detailText
        ? `${message || fallback}: ${detailText}`
        : (message || fallback);
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const hasRequestIdText = finalMessage.includes('requestId:');
    const withRequestId = requestId && !hasRequestIdText ? `${finalMessage} (requestId: ${requestId})` : finalMessage;

    if (!codeText) {
        return withRequestId;
    }

    return `[${codeText}] ${withRequestId}`;
}
