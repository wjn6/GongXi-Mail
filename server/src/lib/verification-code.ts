/**
 * 邮件验证码提取（服务端）。
 * 与前端 web/src/utils/mail.ts 的规则保持一致，供 /api/wait_code 自动识别使用。
 */

const HTML_ENTITY_MAP: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
};

/** 将 HTML 粗略转换为纯文本（仅用于匹配，不做渲染） */
export function htmlToPlainText(html: string): string {
    if (!html) {
        return '';
    }
    return html
        .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, (entity) => HTML_ENTITY_MAP[entity.toLowerCase()] ?? ' ')
        .replace(/[ \t\f\v\u00a0]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
}

/** 用于匹配的邮件正文：优先 HTML 转纯文本（Graph 的 text 只是 bodyPreview，可能被截断） */
export function getMessageMatchText(text: string, html: string): string {
    const fromHtml = htmlToPlainText(html);
    if (fromHtml) {
        return fromHtml;
    }
    return (text || '').trim();
}

const CODE_KEYWORD_RE = /(验证码|校验码|动态码|确认码|激活码|安全码|一次性|verification|verify|security|confirm|one[-\s]?time|passcode|otp|pin|code)/gi;
const CODE_CANDIDATE_RE = /(?<![\d\w-])(\d{4,8})(?![\d\w-])/g;

/**
 * 从邮件主题/正文中提取最可能的验证码（4-8 位数字）。
 * 仅在验证码关键词附近出现，或主题中出现 6 位数字时返回，以减少误报。
 */
export function extractVerificationCode(subject: string, body: string): string | null {
    const sources = [subject || '', body || ''];
    let best: { code: string; score: number } | null = null;

    sources.forEach((source, sourceIndex) => {
        if (!source) {
            return;
        }
        const keywordRanges: Array<{ start: number; end: number }> = [];
        for (const match of source.matchAll(CODE_KEYWORD_RE)) {
            const start = match.index ?? 0;
            keywordRanges.push({ start, end: start + match[0].length });
        }

        for (const match of source.matchAll(CODE_CANDIDATE_RE)) {
            const code = match[1];
            const index = match.index ?? 0;
            const codeEnd = index + code.length;
            let score = 0;

            // 关键词在前（"验证码：123456"）或紧随其后（"123456 is your code"）
            const nearKeyword = keywordRanges.some(({ start, end }) =>
                (index >= end - 2 && index - end <= 60)
                || (start >= codeEnd && start - codeEnd <= 30)
            );
            if (nearKeyword) score += 3;
            if (code.length === 6) score += 2;
            else if (code.length === 4 || code.length === 8) score += 0.5;
            if (sourceIndex === 0) score += 1; // 主题中的数字更可信
            if (code.length === 4 && /^(19|20)\d{2}$/.test(code)) score -= 3; // 年份
            if (/^(\d)\1+$/.test(code)) score -= 5; // 000000 之类

            if (!best || score > best.score) {
                best = { code, score };
            }
        }
    });

    const result = best as { code: string; score: number } | null;
    return result && result.score >= 3 ? result.code : null;
}

/**
 * 使用用户正则匹配：有捕获组时返回第一个捕获组，否则返回整体匹配。
 * 依次匹配主题与正文，调用方需先用 isSafeUserRegex 校验。
 */
export function matchWithUserRegex(regex: RegExp, subject: string, body: string): string | null {
    for (const source of [subject || '', body || '']) {
        if (!source) continue;
        const match = source.match(regex);
        if (match) {
            return match[1] ?? match[0];
        }
    }
    return null;
}
