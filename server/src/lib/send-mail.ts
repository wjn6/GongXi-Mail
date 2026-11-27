/**
 * 发信相关的纯函数（不依赖数据库 / 环境配置，便于单元测试）：
 * 地址解析、请求归一化、附件校验、Graph 请求体构造、Graph 错误分类、幂等哈希、账号排序规则。
 */
import { createHash } from 'node:crypto';

/** Graph 单次 sendMail 请求内联附件总大小上限（解码后字节）；更大的附件需要分段上传 */
export const SEND_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
export const SEND_ATTACHMENT_MAX_COUNT = 20;
export const SEND_SUBJECT_MAX_LENGTH = 998;
export const SEND_CUSTOM_HEADER_MAX_COUNT = 10;
/** Resend：to 最多 50 个 */
export const SEND_TO_MAX = 50;
/** to + cc + bcc 硬上限（分组可配置更小的值） */
export const SEND_RECIPIENTS_HARD_LIMIT = 150;

export class SendRequestError extends Error {
    constructor(
        public code: string,
        message: string,
        public statusCode: number = 422,
        public field?: string
    ) {
        super(message);
        this.name = 'SendRequestError';
    }
}

export interface MailAddress {
    address: string;
    name?: string;
}

export interface SendAttachmentInput {
    filename?: string;
    /** base64 内容 */
    content?: string;
    contentType?: string;
    /** 内联图片的 Content-ID（HTML 中以 cid: 引用） */
    contentId?: string;
    /** 远程地址：调用方需先下载并转换为 content */
    path?: string;
}

export interface SendMailInput {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | string[];
    subject: string;
    html?: string;
    text?: string;
    attachments?: SendAttachmentInput[];
    headers?: Record<string, unknown>;
    /** 发件人显示名（地址始终为实际发件账号） */
    fromName?: string;
    saveToSentItems?: boolean;
}

export interface NormalizedAttachment {
    filename: string;
    contentType: string;
    contentBase64: string;
    contentId?: string;
    size: number;
}

export interface NormalizedSendRequest {
    to: MailAddress[];
    cc: MailAddress[];
    bcc: MailAddress[];
    replyTo: MailAddress[];
    subject: string;
    html: string | null;
    text: string | null;
    attachments: NormalizedAttachment[];
    attachmentBytes: number;
    headers: Array<{ name: string; value: string }>;
    fromName?: string;
    saveToSentItems: boolean;
    recipientCount: number;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function isValidEmailAddress(address: string): boolean {
    return address.length <= 254 && EMAIL_RE.test(address);
}

/**
 * 解析单个地址："a@b.com"、"Name <a@b.com>"、"\"Name\" <a@b.com>"。无效返回 null。
 */
export function parseMailAddress(input: string): MailAddress | null {
    const raw = (input || '').trim();
    if (!raw) return null;

    const angle = /^(.*)<([^<>]+)>\s*$/.exec(raw);
    if (angle) {
        const address = angle[2].trim();
        const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim();
        if (!isValidEmailAddress(address)) return null;
        return name ? { address, name } : { address };
    }
    return isValidEmailAddress(raw) ? { address: raw } : null;
}

export function formatMailAddress(item: MailAddress): string {
    if (!item.name) return item.address;
    const needsQuote = /[",<>@]/.test(item.name);
    return needsQuote ? `"${item.name.replace(/"/g, '')}" <${item.address}>` : `${item.name} <${item.address}>`;
}

/**
 * 归一化地址列表（字符串或字符串数组），去重（不区分大小写）。
 */
export function normalizeAddressList(value: unknown, field: string): MailAddress[] {
    if (value === undefined || value === null) return [];
    const items = Array.isArray(value) ? value : [value];

    const result: MailAddress[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (typeof item !== 'string') {
            throw new SendRequestError('INVALID_ADDRESS', `Invalid \`${field}\` field.`, 422, field);
        }
        if (!item.trim()) continue;
        const parsed = parseMailAddress(item);
        if (!parsed) {
            throw new SendRequestError(
                'INVALID_ADDRESS',
                `Invalid \`${field}\` field. The email address needs to follow the \`email@example.com\` or \`Name <email@example.com>\` format.`,
                422,
                field
            );
        }
        const key = parsed.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(parsed);
    }
    return result;
}

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
    txt: 'text/plain',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    json: 'application/json',
    xml: 'application/xml',
    pdf: 'application/pdf',
    zip: 'application/zip',
    gz: 'application/gzip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ics: 'text/calendar',
    eml: 'message/rfc822',
};

export function guessContentType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || '';
    return EXTENSION_CONTENT_TYPES[ext] || 'application/octet-stream';
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function sanitizeFilename(value: string | undefined): string {
    if (!value) return '';
    // eslint-disable-next-line no-control-regex
    const cleaned = value.replace(/[\\/\u0000-\u001f]/g, '_').trim();
    return cleaned.slice(0, 255);
}

/**
 * 校验并归一化附件（仅 base64 content；path 需调用方先下载），总大小受限。
 */
export function normalizeAttachments(
    attachments: SendAttachmentInput[] | undefined,
    maxBytes: number = SEND_ATTACHMENT_MAX_BYTES
): { attachments: NormalizedAttachment[]; totalBytes: number } {
    if (!attachments || attachments.length === 0) {
        return { attachments: [], totalBytes: 0 };
    }
    if (attachments.length > SEND_ATTACHMENT_MAX_COUNT) {
        throw new SendRequestError('INVALID_ATTACHMENT', `At most ${SEND_ATTACHMENT_MAX_COUNT} attachments are allowed.`, 422, 'attachments');
    }

    let totalBytes = 0;
    const normalized = attachments.map((item, index) => {
        const field = `attachments[${index}]`;
        if (item.path && !item.content) {
            throw new SendRequestError('INVALID_ATTACHMENT', `${field}: remote attachment was not downloaded.`, 422, field);
        }
        const filename = sanitizeFilename(item.filename);
        if (!filename) {
            throw new SendRequestError('INVALID_ATTACHMENT', `${field}: \`filename\` is required.`, 422, field);
        }
        if (typeof item.content !== 'string' || !item.content) {
            throw new SendRequestError('INVALID_ATTACHMENT', 'Attachment must have either a content or path.', 422, field);
        }
        const base64 = item.content.replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '');
        if (!base64 || base64.length % 4 === 1 || !BASE64_RE.test(base64)) {
            throw new SendRequestError('INVALID_ATTACHMENT', `${field}: \`content\` must be valid base64.`, 422, field);
        }
        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length === 0) {
            throw new SendRequestError('INVALID_ATTACHMENT', `${field}: \`content\` is empty.`, 422, field);
        }
        totalBytes += buffer.length;
        if (totalBytes > maxBytes) {
            throw new SendRequestError(
                'INVALID_ATTACHMENT',
                `Attachments exceed ${Math.floor(maxBytes / 1024 / 1024)} MB in total (limit of a single Microsoft Graph sendMail request).`,
                422,
                'attachments'
            );
        }
        const contentId = item.contentId?.trim().replace(/^<|>$/g, '') || undefined;
        return {
            filename,
            contentType: (item.contentType && item.contentType.trim()) || guessContentType(filename),
            // 重新编码，去掉 data URL 前缀与空白
            contentBase64: buffer.toString('base64'),
            ...(contentId ? { contentId } : {}),
            size: buffer.length,
        };
    });

    return { attachments: normalized, totalBytes };
}

/**
 * 自定义头：Graph 只允许以 X- 开头的头，其它头直接拒绝（不静默丢弃）。
 */
export function normalizeCustomHeaders(headers: unknown): Array<{ name: string; value: string }> {
    if (headers === undefined || headers === null) return [];
    if (typeof headers !== 'object' || Array.isArray(headers)) {
        throw new SendRequestError('INVALID_HEADER', 'Invalid `headers` field. It must be an object of string values.', 422, 'headers');
    }
    const result: Array<{ name: string; value: string }> = [];
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
        if (!/^x-[a-z0-9-]+$/i.test(name)) {
            throw new SendRequestError(
                'INVALID_HEADER',
                `Invalid \`headers\` field. Only custom headers starting with \`X-\` are supported when sending through Microsoft Graph (got \`${name.slice(0, 64)}\`).`,
                422,
                'headers'
            );
        }
        if (typeof value !== 'string' || value.length > 1000 || /[\r\n]/.test(value)) {
            throw new SendRequestError('INVALID_HEADER', `Invalid \`headers\` field. Header \`${name}\` must be a single-line string.`, 422, 'headers');
        }
        result.push({ name, value });
    }
    if (result.length > SEND_CUSTOM_HEADER_MAX_COUNT) {
        throw new SendRequestError('INVALID_HEADER', `Invalid \`headers\` field. At most ${SEND_CUSTOM_HEADER_MAX_COUNT} custom headers are allowed.`, 422, 'headers');
    }
    return result;
}

/**
 * 校验并归一化发信请求（附件需已下载为 content；分组的收件人上限在选号时检查）。
 */
export function normalizeSendRequest(input: SendMailInput): NormalizedSendRequest {
    if (input.to === undefined || input.to === null || (Array.isArray(input.to) && input.to.length === 0) || input.to === '') {
        throw new SendRequestError('MISSING_FIELD', 'Missing `to` field.', 422, 'to');
    }
    const to = normalizeAddressList(input.to, 'to');
    const cc = normalizeAddressList(input.cc, 'cc');
    const bcc = normalizeAddressList(input.bcc, 'bcc');
    const replyTo = normalizeAddressList(input.replyTo, 'reply_to');

    if (to.length === 0) {
        throw new SendRequestError('MISSING_FIELD', 'Missing `to` field.', 422, 'to');
    }
    if (to.length > SEND_TO_MAX) {
        throw new SendRequestError('INVALID_ADDRESS', `Invalid \`to\` field. At most ${SEND_TO_MAX} recipients are allowed.`, 422, 'to');
    }
    const recipientCount = to.length + cc.length + bcc.length;
    if (recipientCount > SEND_RECIPIENTS_HARD_LIMIT) {
        throw new SendRequestError('INVALID_ADDRESS', `Too many recipients. At most ${SEND_RECIPIENTS_HARD_LIMIT} recipients (to + cc + bcc) are allowed.`, 422, 'to');
    }

    if (typeof input.subject !== 'string' || !input.subject.trim()) {
        throw new SendRequestError('MISSING_FIELD', 'Missing `subject` field.', 422, 'subject');
    }
    const subject = input.subject.replace(/[\r\n]+/g, ' ').trim();
    if (subject.length > SEND_SUBJECT_MAX_LENGTH) {
        throw new SendRequestError('INVALID_FIELD', `Invalid \`subject\` field. It must be at most ${SEND_SUBJECT_MAX_LENGTH} characters.`, 422, 'subject');
    }

    const html = typeof input.html === 'string' && input.html.trim() ? input.html : null;
    const text = typeof input.text === 'string' && input.text.trim() ? input.text : null;
    if (!html && !text) {
        throw new SendRequestError('MISSING_FIELD', 'Missing `html` or `text` field.', 422, 'html');
    }

    const { attachments, totalBytes } = normalizeAttachments(input.attachments);
    const headers = normalizeCustomHeaders(input.headers);
    const fromName = input.fromName?.replace(/[\r\n"<>]+/g, ' ').trim().slice(0, 100) || undefined;

    return {
        to,
        cc,
        bcc,
        replyTo,
        subject,
        html,
        text,
        attachments,
        attachmentBytes: totalBytes,
        headers,
        fromName,
        saveToSentItems: input.saveToSentItems !== false,
        recipientCount,
    };
}

function toGraphRecipients(list: MailAddress[]) {
    return list.map((item) => ({
        emailAddress: item.name ? { address: item.address, name: item.name } : { address: item.address },
    }));
}

/**
 * 构造 Graph POST /me/sendMail 请求体。Graph 只支持一种正文：有 html 时用 html，否则用 text。
 */
export function buildGraphSendPayload(request: NormalizedSendRequest, senderAddress: string) {
    const message: Record<string, unknown> = {
        subject: request.subject,
        body: request.html
            ? { contentType: 'HTML', content: request.html }
            : { contentType: 'Text', content: request.text ?? '' },
        toRecipients: toGraphRecipients(request.to),
    };
    if (request.cc.length > 0) message.ccRecipients = toGraphRecipients(request.cc);
    if (request.bcc.length > 0) message.bccRecipients = toGraphRecipients(request.bcc);
    if (request.replyTo.length > 0) message.replyTo = toGraphRecipients(request.replyTo);
    if (request.fromName) {
        message.from = { emailAddress: { address: senderAddress, name: request.fromName } };
    }
    if (request.headers.length > 0) message.internetMessageHeaders = request.headers;
    if (request.attachments.length > 0) {
        message.attachments = request.attachments.map((item) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: item.filename,
            contentType: item.contentType,
            contentBytes: item.contentBase64,
            ...(item.contentId ? { contentId: item.contentId, isInline: true } : {}),
        }));
    }
    return { message, saveToSentItems: request.saveToSentItems };
}

// ============================================================
// Graph 错误分类
// ============================================================

export type SendFailureKind = 'THROTTLED' | 'BLOCKED' | 'PERMISSION' | 'AUTH' | 'TRANSIENT' | 'REQUEST';

export interface SendFailure {
    kind: SendFailureKind;
    /** 账号冷却秒数（0 表示不冷却） */
    cooldownSeconds: number;
    /** 是否换下一个账号重试 */
    retryOtherAccount: boolean;
    /** 是否将账号标记为不可发信 */
    markDenied: boolean;
    graphCode: string;
    message: string;
}

const BLOCKED_RE = /OutboundSpam|ErrorMessageSubmissionBlocked|SubmissionQuota|ExceededMessageLimit|MessageRateLimit|account (?:is |has been )?(?:temporarily )?(?:blocked|suspended)|sending (?:is )?(?:blocked|suspended)/i;
const PERMISSION_CODES = new Set([
    'ErrorAccessDenied',
    'ErrorSendAsDenied',
    'Authorization_RequestDenied',
    'AccessDenied',
    'MailboxNotEnabledForRESTAPI',
    'MailboxNotSupportedForRESTAPI',
]);

export function parseRetryAfterSeconds(value: string | null | undefined, now: number = Date.now()): number | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed);
    }
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return null;
    return Math.max(0, Math.ceil((date - now) / 1000));
}

function parseGraphError(bodyText: string): { code: string; message: string } {
    try {
        const parsed = JSON.parse(bodyText) as { error?: { code?: unknown; message?: unknown } };
        const code = typeof parsed.error?.code === 'string' ? parsed.error.code : '';
        const message = typeof parsed.error?.message === 'string' ? parsed.error.message : '';
        return { code, message: message || bodyText.slice(0, 300) };
    } catch {
        return { code: '', message: bodyText.slice(0, 300) };
    }
}

/**
 * 根据 Graph 响应分类发信失败，决定冷却、是否换号重试、是否标记无权限。
 */
export function classifyGraphSendError(status: number, bodyText: string, retryAfter?: string | null): SendFailure {
    const { code, message } = parseGraphError(bodyText || '');
    const haystack = `${code} ${message}`;
    const base = { graphCode: code || `HTTP_${status}`, message: message || `HTTP ${status}` };

    if (BLOCKED_RE.test(haystack)) {
        return { ...base, kind: 'BLOCKED', cooldownSeconds: 24 * 60 * 60, retryOtherAccount: true, markDenied: false };
    }
    if (status === 429 || code === 'ApplicationThrottled' || code === 'TooManyRequests') {
        const seconds = parseRetryAfterSeconds(retryAfter) ?? 60;
        return { ...base, kind: 'THROTTLED', cooldownSeconds: Math.min(Math.max(seconds, 30), 3600), retryOtherAccount: true, markDenied: false };
    }
    if (status === 401 || code === 'InvalidAuthenticationToken') {
        return { ...base, kind: 'AUTH', cooldownSeconds: 10 * 60, retryOtherAccount: true, markDenied: false };
    }
    if (PERMISSION_CODES.has(code) || status === 403) {
        return { ...base, kind: 'PERMISSION', cooldownSeconds: 0, retryOtherAccount: true, markDenied: true };
    }
    if (code === 'ErrorQuotaExceeded') {
        return { ...base, kind: 'BLOCKED', cooldownSeconds: 60 * 60, retryOtherAccount: true, markDenied: false };
    }
    if (status >= 500 || status === 0) {
        return { ...base, kind: 'TRANSIENT', cooldownSeconds: 0, retryOtherAccount: true, markDenied: false };
    }
    return { ...base, kind: 'REQUEST', cooldownSeconds: 0, retryOtherAccount: false, markDenied: false };
}

/** 令牌 scope 中是否包含 Mail.Send（不把 Mail.Send.Shared 误判为 Mail.Send） */
export function hasMailSendScope(scopeText: string | undefined | null): boolean {
    if (!scopeText) return false;
    return scopeText.split(/\s+/).some((scope) => /(^|\/)Mail\.Send$/i.test(scope));
}

// ============================================================
// 幂等
// ============================================================

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 请求体指纹：同一幂等 Key 搭配不同请求体时拒绝（字段顺序无关） */
export function computeRequestHash(value: unknown): string {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}

// ============================================================
// 发信账号挑选（排序规则，与 SQL 实现对照）
// ============================================================

export type SendStrategyName = 'LEAST_USED' | 'ROUND_ROBIN' | 'RANDOM';

export interface SenderCandidate {
    id: number;
    sent24h: number;
    lastSentAt: Date | null;
}

/**
 * 按策略排序候选账号（数据库中以等价 SQL 实现，这里用于单元测试与文档对照）。
 * LEAST_USED：24 小时发信最少优先；ROUND_ROBIN：最久未发信优先；RANDOM：随机。
 */
export function sortSenderCandidates<T extends SenderCandidate>(candidates: T[], strategy: SendStrategyName, random: () => number = Math.random): T[] {
    const byLastSent = (a: T, b: T) => {
        const at = a.lastSentAt?.getTime() ?? -Infinity;
        const bt = b.lastSentAt?.getTime() ?? -Infinity;
        return at === bt ? a.id - b.id : at - bt;
    };
    const list = [...candidates];
    if (strategy === 'RANDOM') {
        return list
            .map((item) => ({ item, key: random() }))
            .sort((a, b) => a.key - b.key)
            .map(({ item }) => item);
    }
    if (strategy === 'ROUND_ROBIN') {
        return list.sort(byLastSent);
    }
    return list.sort((a, b) => (a.sent24h === b.sent24h ? byLastSent(a, b) : a.sent24h - b.sent24h));
}
