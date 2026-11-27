/**
 * SMTP（OAuth2 XOAUTH2）发信相关的纯函数：发信通道选择、邮件构造、SMTP 错误分类、SMTP.Send 权限判断。
 *
 * 为什么需要 SMTP：Graph sendMail 会忽略 message.from 里的自定义显示名，固定使用账号资料里的名称；
 * 通过 SMTP 提交时信头 From 原样保留（已在 outlook.com 账号上实测）。
 */
import type { SendMailOptions } from 'nodemailer';
import { normalizeOAuthTenant } from './oauth-tenant.js';
import type { MailAddress, NormalizedSendRequest, SendFailure } from './send-mail.js';

export type SendTransportMode = 'AUTO' | 'GRAPH' | 'SMTP';
export type SendChannel = 'GRAPH' | 'SMTP';
/** 发信记录中保存的实际通道；GRAPH_FALLBACK = SMTP 不可用改用 Graph（发件人名称不生效） */
export type SendTransportUsed = SendChannel | 'GRAPH_FALLBACK';
export type CapabilityValue = 'UNKNOWN' | 'ALLOWED' | 'DENIED';

export const SMTP_PORT = 587;
/** 刷新令牌换取 SMTP 发信令牌时使用的 scope */
export const SMTP_SEND_SCOPE = 'https://outlook.office.com/SMTP.Send offline_access';

export function normalizeSendTransport(value: unknown): SendTransportMode {
    return value === 'GRAPH' || value === 'SMTP' ? value : 'AUTO';
}

/** 个人账号用 smtp-mail.outlook.com，工作 / 学校账号用 smtp.office365.com */
export function smtpHostFor(tenant: unknown): string {
    return normalizeOAuthTenant(tenant) === 'CONSUMERS' ? 'smtp-mail.outlook.com' : 'smtp.office365.com';
}

/** 令牌 scope 中是否包含 SMTP.Send */
export function hasSmtpSendScope(scopeText: string | undefined | null): boolean {
    if (!scopeText) return false;
    return scopeText.split(/\s+/).some((scope) => /(^|\/)SMTP\.Send$/i.test(scope));
}

/**
 * 账号在分组发信通道下的有效发信能力：
 *   GRAPH / SMTP：取对应通道；AUTO：任一通道可用即可用，两个都不可用才不可用。
 */
export function effectiveSendCapability(mode: unknown, graph: CapabilityValue | null | undefined, smtp: CapabilityValue | null | undefined): CapabilityValue {
    const g = graph ?? 'UNKNOWN';
    const s = smtp ?? 'UNKNOWN';
    const transport = normalizeSendTransport(mode);
    if (transport === 'GRAPH') return g;
    if (transport === 'SMTP') return s;
    if (g === 'ALLOWED' || s === 'ALLOWED') return 'ALLOWED';
    if (g === 'DENIED' && s === 'DENIED') return 'DENIED';
    return 'UNKNOWN';
}

/**
 * 同一账号的发信通道尝试顺序：
 *   GRAPH / SMTP：只用该通道；
 *   AUTO：填了发件人名称时 SMTP 优先（保留名称），否则 Graph 优先，另一个通道作为备用。
 * AUTO 下跳过已确认不可用（DENIED）的通道；都不可用时仍返回首选通道，由实际请求给出错误。
 */
export function resolveChannelOrder(
    mode: unknown,
    hasFromName: boolean,
    capabilities: { graph?: CapabilityValue | null; smtp?: CapabilityValue | null }
): SendChannel[] {
    const transport = normalizeSendTransport(mode);
    if (transport === 'GRAPH') return ['GRAPH'];
    if (transport === 'SMTP') return ['SMTP'];
    const order: SendChannel[] = hasFromName ? ['SMTP', 'GRAPH'] : ['GRAPH', 'SMTP'];
    const usable = order.filter((channel) => (channel === 'GRAPH' ? capabilities.graph : capabilities.smtp) !== 'DENIED');
    return usable.length > 0 ? usable : [order[0]];
}

/**
 * 一个通道失败后，同一账号是否改用下一个通道：只有通道自身的问题（权限、令牌、连接）才换；
 * 限流、封禁属于账号层面，请求错误换通道也没用；结果不确定（可能已发出）时不换，避免重复发送。
 */
export function shouldTryNextChannel(failure: SendFailure): boolean {
    if (!failure.retryOtherAccount) return false;
    return failure.kind === 'PERMISSION' || failure.kind === 'AUTH' || failure.kind === 'TRANSIENT';
}

function toSmtpAddress(item: MailAddress): string | { name: string; address: string } {
    return item.name ? { name: item.name, address: item.address } : item.address;
}

/**
 * 构造 nodemailer 邮件。与 Graph 不同，html 与 text 同时提供时会一起发送（multipart/alternative）。
 */
export function buildSmtpMessage(request: NormalizedSendRequest, senderAddress: string): SendMailOptions {
    const message: SendMailOptions = {
        from: request.fromName ? { name: request.fromName, address: senderAddress } : senderAddress,
        to: request.to.map(toSmtpAddress),
        subject: request.subject,
        disableFileAccess: true,
        disableUrlAccess: true,
    };
    if (request.cc.length > 0) message.cc = request.cc.map(toSmtpAddress);
    if (request.bcc.length > 0) message.bcc = request.bcc.map(toSmtpAddress);
    if (request.replyTo.length > 0) message.replyTo = request.replyTo.map(toSmtpAddress);
    if (request.html) message.html = request.html;
    if (request.text) message.text = request.text;
    if (request.headers.length > 0) {
        message.headers = Object.fromEntries(request.headers.map((item) => [item.name, item.value]));
    }
    if (request.attachments.length > 0) {
        message.attachments = request.attachments.map((item) => ({
            filename: item.filename,
            content: Buffer.from(item.contentBase64, 'base64'),
            contentType: item.contentType,
            ...(item.contentId ? { cid: item.contentId } : {}),
        }));
    }
    return message;
}

// ============================================================
// SMTP 错误分类
// ============================================================

interface SmtpErrorLike {
    code?: unknown;
    responseCode?: unknown;
    response?: unknown;
    command?: unknown;
    message?: unknown;
}

/** 邮箱或租户禁用了 SMTP AUTH（5.7.139），或安全默认值拦截 */
const SMTP_AUTH_DISABLED_RE = /SmtpClientAuthentication is disabled|basic authentication is disabled|security defaults|5\.7\.139/i;
const SMTP_BLOCKED_RE = /OutboundSpam|spam abuse|5\.7\.501|5\.7\.520|5\.7\.705|5\.7\.708|5\.7\.750|SubmissionQuota|ExceededMessageLimit|MessageRateLimit|account (?:is |has been )?(?:temporarily )?(?:blocked|suspended)|sending (?:is )?(?:blocked|suspended)/i;
const SMTP_SEND_AS_RE = /SendAsDenied|5\.7\.60\b|not authorized to send|does not have permissions to send/i;
const SMTP_THROTTLE_RE = /thread limit|throttl|too many|rate limit|concurrent connections|4\.3\.2|4\.7\.(?:0|500)/i;
const NETWORK_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPROTOCOL', 'ETLS']);

/**
 * 根据 nodemailer 抛出的错误分类 SMTP 发信失败（与 Graph 共用 SendFailure，graphCode 形如 SMTP_535_5.7.139）。
 */
export function classifySmtpSendError(err: unknown): SendFailure {
    const e: SmtpErrorLike = err && typeof err === 'object' ? (err as SmtpErrorLike) : { message: String(err) };
    const code = typeof e.code === 'string' ? e.code : '';
    const responseCode = typeof e.responseCode === 'number' ? e.responseCode : 0;
    const command = typeof e.command === 'string' ? e.command.toUpperCase() : '';
    const text = String((typeof e.response === 'string' && e.response) || (typeof e.message === 'string' && e.message) || 'SMTP error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
    const enhanced = /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1];
    const errorCode = `SMTP_${responseCode || code || 'ERROR'}${enhanced ? `_${enhanced}` : ''}`.slice(0, 64);
    const base = { graphCode: errorCode, message: text };

    if (SMTP_AUTH_DISABLED_RE.test(text)) {
        return { ...base, kind: 'PERMISSION', cooldownSeconds: 0, retryOtherAccount: true, markDenied: true };
    }
    if (SMTP_BLOCKED_RE.test(text)) {
        return { ...base, kind: 'BLOCKED', cooldownSeconds: 24 * 60 * 60, retryOtherAccount: true, markDenied: false };
    }
    if (SMTP_SEND_AS_RE.test(text)) {
        return { ...base, kind: 'PERMISSION', cooldownSeconds: 0, retryOtherAccount: true, markDenied: true };
    }
    if (responseCode >= 400 && responseCode < 500 && SMTP_THROTTLE_RE.test(text)) {
        return { ...base, kind: 'THROTTLED', cooldownSeconds: 5 * 60, retryOtherAccount: true, markDenied: false };
    }
    if (code === 'EAUTH' || responseCode === 535 || responseCode === 534 || responseCode === 530) {
        return { ...base, kind: 'AUTH', cooldownSeconds: 10 * 60, retryOtherAccount: true, markDenied: false };
    }
    if (code === 'EENVELOPE' || code === 'EMESSAGE') {
        return { ...base, kind: 'REQUEST', cooldownSeconds: 0, retryOtherAccount: false, markDenied: false };
    }
    if ((responseCode >= 400 && responseCode < 500) || NETWORK_CODES.has(code) || !responseCode) {
        // DATA 阶段连接中断：邮件可能已被接收，不换号 / 换通道重试，避免重复发送
        const ambiguous = !responseCode && command === 'DATA';
        return { ...base, kind: 'TRANSIENT', cooldownSeconds: 0, retryOtherAccount: !ambiguous, markDenied: false };
    }
    return { ...base, kind: 'REQUEST', cooldownSeconds: 0, retryOtherAccount: false, markDenied: false };
}
