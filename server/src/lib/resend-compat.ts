/**
 * Resend 接口兼容层（纯函数）：请求字段校验、错误格式、响应对象格式。
 * 字段与返回结构以 Resend 官方 API / SDK 为准，不额外扩展字段。
 */
import {
    formatMailAddress,
    parseMailAddress,
    type MailAddress,
    type SendAttachmentInput,
    type SendMailInput,
    type SendRequestError,
} from './send-mail.js';

/** Resend 错误类型（取自官方 SDK 的错误名称与错误码文档） */
export type ResendErrorName =
    | 'invalid_idempotency_key'
    | 'validation_error'
    | 'missing_api_key'
    | 'restricted_api_key'
    | 'not_found'
    | 'method_not_allowed'
    | 'invalid_idempotent_request'
    | 'concurrent_idempotent_requests'
    | 'invalid_attachment'
    | 'invalid_from_address'
    | 'invalid_parameter'
    | 'missing_required_field'
    | 'daily_quota_exceeded'
    | 'rate_limit_exceeded'
    | 'application_error'
    | 'internal_server_error';

export class ResendApiError extends Error {
    constructor(
        public statusCode: number,
        public errorName: ResendErrorName,
        message: string
    ) {
        super(message);
        this.name = 'ResendApiError';
    }

    toBody() {
        return { statusCode: this.statusCode, name: this.errorName, message: this.message };
    }
}

export const RESEND_BATCH_MAX = 100;
export const RESEND_LIST_DEFAULT_LIMIT = 20;
export const RESEND_LIST_MAX_LIMIT = 100;
export const RESEND_IDEMPOTENCY_KEY_MAX = 256;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_RE = /^[A-Za-z0-9_-]{1,256}$/;

export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_RE.test(value);
}

/** 本系统的发信请求错误 → Resend 错误类型 */
export function toResendError(err: SendRequestError): ResendApiError {
    switch (err.code) {
        case 'MISSING_FIELD':
            return new ResendApiError(422, 'missing_required_field', err.message);
        case 'INVALID_ATTACHMENT':
            return new ResendApiError(422, 'invalid_attachment', err.message);
        case 'INVALID_FROM':
            return new ResendApiError(422, 'invalid_from_address', err.message);
        default:
            return new ResendApiError(422, 'validation_error', err.message);
    }
}

export interface ResendTag {
    name: string;
    value: string;
}

export interface ParsedResendEmail {
    /** 请求中的 from 原文 */
    requestedFrom: string;
    from: MailAddress;
    tags: ResendTag[];
    /** 归一化前的发信输入（附件中可能仍含远程 path） */
    sendInput: SendMailInput;
}

function isPresent(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
}

/**
 * 校验单封 Resend 邮件请求体（不含附件下载与最终归一化）。
 * 不支持的 Resend 功能明确返回错误，不静默忽略。
 */
export function parseResendEmailPayload(raw: unknown, options: { batch: boolean }): ParsedResendEmail {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ResendApiError(422, 'validation_error', 'Invalid request body. Expected a JSON object.');
    }
    const body = raw as Record<string, unknown>;

    if (isPresent(body.template)) {
        throw new ResendApiError(422, 'validation_error', 'The `template` field is not supported: emails are sent through Microsoft Graph accounts, Resend templates are not available.');
    }
    if (isPresent(body.scheduled_at)) {
        throw new ResendApiError(422, 'validation_error', 'The `scheduled_at` field is not supported yet. Send the email without scheduling.');
    }
    if (isPresent(body.topic_id)) {
        throw new ResendApiError(422, 'validation_error', 'The `topic_id` field is not supported.');
    }

    if (!isPresent(body.from)) {
        throw new ResendApiError(422, 'missing_required_field', 'Missing `from` field.');
    }
    if (typeof body.from !== 'string') {
        throw new ResendApiError(422, 'invalid_from_address', 'Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.');
    }
    const from = parseMailAddress(body.from);
    if (!from) {
        throw new ResendApiError(422, 'invalid_from_address', 'Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.');
    }

    for (const field of ['subject', 'html', 'text'] as const) {
        if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
            throw new ResendApiError(422, 'validation_error', `Invalid \`${field}\` field. It must be a string.`);
        }
    }

    const tags = parseTags(body.tags);
    const attachments = parseAttachmentList(body.attachments, options.batch);

    return {
        requestedFrom: body.from.trim().slice(0, 512),
        from,
        tags,
        sendInput: {
            to: body.to as string | string[],
            cc: body.cc as string | string[] | undefined,
            bcc: body.bcc as string | string[] | undefined,
            replyTo: body.reply_to as string | string[] | undefined,
            subject: body.subject as string,
            html: (body.html as string | undefined) ?? undefined,
            text: (body.text as string | undefined) ?? undefined,
            headers: body.headers as Record<string, unknown> | undefined,
            attachments,
            fromName: from.name,
        },
    };
}

function parseTags(value: unknown): ResendTag[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new ResendApiError(422, 'validation_error', 'Invalid `tags` field. It must be an array of `{ name, value }` objects.');
    }
    return value.map((item, index) => {
        const tag = item as { name?: unknown; value?: unknown } | null;
        if (!tag || typeof tag.name !== 'string' || typeof tag.value !== 'string' || !TAG_RE.test(tag.name) || !TAG_RE.test(tag.value)) {
            throw new ResendApiError(
                422,
                'validation_error',
                `Invalid \`tags[${index}]\` field. Tag names and values can only contain ASCII letters, numbers, underscores or dashes, and must be at most 256 characters.`
            );
        }
        return { name: tag.name, value: tag.value };
    });
}

function parseAttachmentList(value: unknown, batch: boolean): SendAttachmentInput[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (batch) {
        throw new ResendApiError(422, 'validation_error', 'The `attachments` field is not supported in batch emails.');
    }
    if (!Array.isArray(value)) {
        throw new ResendApiError(422, 'invalid_attachment', 'Invalid `attachments` field. It must be an array.');
    }
    return value.map((item, index) => {
        const att = item as Record<string, unknown> | null;
        if (!att || typeof att !== 'object') {
            throw new ResendApiError(422, 'invalid_attachment', 'Attachment must have either a content or path.');
        }
        const content = typeof att.content === 'string' && att.content ? att.content : undefined;
        const path = typeof att.path === 'string' && att.path ? att.path : undefined;
        if (!content && !path) {
            throw new ResendApiError(422, 'invalid_attachment', 'Attachment must have either a content or path.');
        }
        if (!content && path && !/^https:\/\//i.test(path)) {
            throw new ResendApiError(422, 'invalid_attachment', `Invalid \`attachments[${index}].path\` field. Only https URLs are supported.`);
        }
        const filename = typeof att.filename === 'string' ? att.filename : undefined;
        if (content && !filename) {
            throw new ResendApiError(422, 'invalid_attachment', `Invalid \`attachments[${index}]\` field. \`filename\` is required when sending \`content\`.`);
        }
        return {
            filename,
            content,
            path: content ? undefined : path,
            contentType: typeof att.content_type === 'string' ? att.content_type : undefined,
            contentId: typeof att.content_id === 'string' ? att.content_id : undefined,
        };
    });
}

/** x-batch-validation 请求头 */
export function parseBatchValidationMode(value: unknown): 'strict' | 'permissive' {
    if (value === undefined || value === null || value === '') return 'strict';
    const raw = Array.isArray(value) ? value[0] : value;
    const mode = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (mode === 'strict' || mode === 'permissive') return mode;
    throw new ResendApiError(422, 'validation_error', 'Invalid `x-batch-validation` header. Use `strict` or `permissive`.');
}

export function validateIdempotencyKey(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const key = Array.isArray(value) ? value[0] : value;
    if (typeof key !== 'string' || key.length < 1 || key.length > RESEND_IDEMPOTENCY_KEY_MAX) {
        throw new ResendApiError(400, 'invalid_idempotency_key', 'Idempotency keys, if present, must have between 1 and 256 characters.');
    }
    return key;
}

export interface ResendListQuery {
    limit: number;
    after?: string;
    before?: string;
}

export function parseListQuery(query: unknown): ResendListQuery {
    const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
    let limit = RESEND_LIST_DEFAULT_LIMIT;
    if (q.limit !== undefined && q.limit !== '') {
        const parsed = Number(q.limit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > RESEND_LIST_MAX_LIMIT) {
            throw new ResendApiError(422, 'validation_error', `The \`limit\` parameter must be an integer between 1 and ${RESEND_LIST_MAX_LIMIT}.`);
        }
        limit = parsed;
    }
    const after = typeof q.after === 'string' && q.after ? q.after : undefined;
    const before = typeof q.before === 'string' && q.before ? q.before : undefined;
    if (after && before) {
        throw new ResendApiError(422, 'validation_error', 'The `after` and `before` parameters cannot be used together.');
    }
    for (const [name, cursor] of [['after', after], ['before', before]] as const) {
        if (cursor && !isUuid(cursor)) {
            throw new ResendApiError(422, 'invalid_parameter', `The \`${name}\` parameter must be a valid UUID.`);
        }
    }
    return { limit, after, before };
}

/** Resend 时间格式，例如 "2026-04-03 22:13:42.674981+00" */
export function formatResendTimestamp(date: Date | null | undefined): string | null {
    if (!date) return null;
    const iso = date.toISOString(); // 2026-04-03T22:13:42.674Z
    return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000+00`;
}

export type SendStatusName = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED';

/** 发信状态 → Resend last_event（Graph 只能确认已提交发送，没有送达 / 打开等事件） */
export function toResendLastEvent(status: SendStatusName): 'queued' | 'sent' | 'failed' {
    if (status === 'SENT') return 'sent';
    if (status === 'FAILED') return 'failed';
    return 'queued';
}

export interface SendLogLike {
    id: string;
    status: SendStatusName;
    requestedFrom: string;
    fromName: string | null;
    fromAddress: string | null;
    toAddresses: unknown;
    ccAddresses: unknown;
    bccAddresses: unknown;
    replyTo: unknown;
    subject: string;
    html: string | null;
    text: string | null;
    tags: unknown;
    createdAt: Date;
}

function addressListFromJson(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is MailAddress => !!item && typeof item === 'object' && typeof (item as MailAddress).address === 'string')
        .map((item) => formatMailAddress(item));
}

function tagsFromJson(value: unknown): ResendTag[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ResendTag => !!item && typeof item === 'object'
        && typeof (item as ResendTag).name === 'string' && typeof (item as ResendTag).value === 'string');
}

/** 实际发件人：显示名 + 实际发件账号；尚未分配账号时返回请求中的 from */
export function resolveFromField(row: Pick<SendLogLike, 'requestedFrom' | 'fromName' | 'fromAddress'>): string {
    if (!row.fromAddress) return row.requestedFrom;
    return formatMailAddress(row.fromName ? { address: row.fromAddress, name: row.fromName } : { address: row.fromAddress });
}

/** GET /emails/:id 的响应对象 */
export function toResendEmailObject(row: SendLogLike) {
    return {
        object: 'email' as const,
        id: row.id,
        // Graph sendMail 不返回 Message-ID
        message_id: null,
        to: addressListFromJson(row.toAddresses),
        from: resolveFromField(row),
        created_at: formatResendTimestamp(row.createdAt),
        subject: row.subject,
        html: row.html,
        text: row.text,
        bcc: addressListFromJson(row.bccAddresses),
        cc: addressListFromJson(row.ccAddresses),
        reply_to: addressListFromJson(row.replyTo),
        last_event: toResendLastEvent(row.status),
        scheduled_at: null,
        tags: tagsFromJson(row.tags),
    };
}

/** GET /emails 列表项（不含 html / text / tags / object，与 Resend 一致） */
export function toResendListItem(row: SendLogLike) {
    const { object: _object, html: _html, text: _text, tags: _tags, ...rest } = toResendEmailObject(row);
    return rest;
}
