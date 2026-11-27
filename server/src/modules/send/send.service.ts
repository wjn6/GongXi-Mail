/**
 * 发信池：按分组配置挑选发件账号，按分组发信通道（Graph / SMTP）发出，处理失败冷却、换通道与换号重试。
 * 被 Resend 兼容接口（同步单封 / 排队批量）、后台在线发信与测试发信共用。
 */
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { mailService } from '../mail/mail.service.js';
import {
    buildGraphSendPayload,
    classifyGraphSendError,
    type MailAddress,
    type NormalizedSendRequest,
    type SendFailure,
    type SendFailureKind,
} from '../../lib/send-mail.js';
import {
    buildSmtpMessage,
    classifySmtpSendError,
    effectiveSendCapability,
    normalizeSendTransport,
    resolveChannelOrder,
    shouldTryNextChannel,
    type CapabilityValue,
    type SendChannel,
    type SendTransportUsed,
} from '../../lib/smtp-send.js';

/** 单封邮件最多尝试的账号数 */
const MAX_ACCOUNT_ATTEMPTS = 3;
/** 令牌失败时的账号冷却秒数 */
const TOKEN_FAILURE_COOLDOWN_SECONDS = 10 * 60;

const DB_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/**
 * 账号在所在分组发信通道下的有效发信能力（SQL 表达式，返回文本 ALLOWED / DENIED / UNKNOWN）。
 * 要求查询中 email_accounts 别名为 a、email_groups 别名为 g（可为 LEFT JOIN，未分组按 AUTO）。
 * 与 lib/smtp-send.ts 的 effectiveSendCapability 一致。
 */
export const EFFECTIVE_SEND_CAPABILITY_SQL = Prisma.sql`(CASE COALESCE(g.send_transport::text, 'AUTO')
    WHEN 'GRAPH' THEN a.send_capability::text
    WHEN 'SMTP' THEN a.smtp_capability::text
    ELSE CASE
        WHEN a.send_capability = 'ALLOWED' OR a.smtp_capability = 'ALLOWED' THEN 'ALLOWED'
        WHEN a.send_capability = 'DENIED' AND a.smtp_capability = 'DENIED' THEN 'DENIED'
        ELSE 'UNKNOWN'
    END
END)`;

export interface SendScope {
    allowedGroupIds?: number[];
    allowedEmailIds?: number[];
}

/** 无法分配发件账号的原因（映射为 Resend 错误） */
export type NoSenderReason =
    | 'NO_POOL'
    | 'FROM_NOT_IN_POOL'
    | 'NO_PERMISSION'
    | 'TOO_MANY_RECIPIENTS'
    | 'DAILY_QUOTA'
    | 'RATE_LIMITED';

export type SendOutcome =
    | { ok: true; logId: string; accountId: number; fromAddress: string; attempts: number; transport: SendTransportUsed }
    | {
        ok: false;
        logId: string;
        attempts: number;
        /** 是否没发出任何请求就结束（未分配到账号） */
        noAttempt: boolean;
        reason: NoSenderReason | SendFailureKind;
        message: string;
        /** 稍后重试可能成功（排队邮件用） */
        retryable: boolean;
        maxRecipients?: number;
    };

interface PickedAccount {
    id: number;
    email: string;
    clientId: string;
    refreshToken: string;
    /** 独立 IMAP / SMTP 凭据（加密），可为空 */
    imapClientId: string | null;
    imapRefreshToken: string | null;
    sendCapability: CapabilityValue;
    smtpCapability: CapabilityValue;
    groupId: number | null;
    oauthTenant: string | null;
    sendTransport: string | null;
}

interface PickOptions {
    scope: SendScope;
    recipientCount: number;
    preferredAddress?: string;
    excludeIds: number[];
}

function scopeConditions(scope: SendScope): Prisma.Sql[] {
    const conditions: Prisma.Sql[] = [];
    if (scope.allowedGroupIds && scope.allowedGroupIds.length > 0) {
        conditions.push(Prisma.sql`a.group_id IN (${Prisma.join(scope.allowedGroupIds)})`);
    }
    if (scope.allowedEmailIds && scope.allowedEmailIds.length > 0) {
        conditions.push(Prisma.sql`a.id IN (${Prisma.join(scope.allowedEmailIds)})`);
    }
    return conditions;
}

const SENT_24H = Prisma.sql`(
    SELECT count(*) FROM send_logs l
    WHERE l.email_account_id = a.id
      AND l.status IN ('SENT', 'SENDING')
      AND l.attempted_at > ${DB_NOW} - interval '24 hours'
)`;

/**
 * 在事务内挑选并锁定一个可用发件账号，同时登记本次尝试（更新 last_sent_at 与发信记录）。
 */
async function pickAndReserveSender(logId: string, options: PickOptions): Promise<PickedAccount | null> {
    return prisma.$transaction(async (tx) => {
        const conditions: Prisma.Sql[] = [
            Prisma.sql`a.status = 'ACTIVE'`,
            Prisma.sql`g.send_enabled = true`,
            Prisma.sql`${EFFECTIVE_SEND_CAPABILITY_SQL} <> 'DENIED'`,
            Prisma.sql`(a.send_cooldown_until IS NULL OR a.send_cooldown_until <= ${DB_NOW})`,
            Prisma.sql`(a.last_sent_at IS NULL OR a.last_sent_at <= ${DB_NOW} - make_interval(secs => g.send_interval_seconds))`,
            Prisma.sql`g.send_max_recipients >= ${options.recipientCount}`,
            Prisma.sql`${SENT_24H} < g.send_daily_limit`,
            ...scopeConditions(options.scope),
        ];
        if (options.excludeIds.length > 0) {
            conditions.push(Prisma.sql`a.id NOT IN (${Prisma.join(options.excludeIds)})`);
        }
        if (options.preferredAddress) {
            conditions.push(Prisma.sql`lower(a.email) = lower(${options.preferredAddress})`);
        }

        const rows = await tx.$queryRaw<PickedAccount[]>`
            SELECT a.id, a.email, a.client_id AS "clientId", a.refresh_token AS "refreshToken",
                   a.imap_client_id AS "imapClientId", a.imap_refresh_token AS "imapRefreshToken",
                   a.send_capability::text AS "sendCapability", a.smtp_capability::text AS "smtpCapability",
                   a.group_id AS "groupId",
                   g.oauth_tenant::text AS "oauthTenant", g.send_transport::text AS "sendTransport"
            FROM email_accounts a
            JOIN email_groups g ON g.id = a.group_id
            WHERE ${Prisma.join(conditions, ' AND ')}
            ORDER BY
                CASE WHEN g.send_strategy = 'RANDOM' THEN random() ELSE 0 END,
                CASE WHEN g.send_strategy = 'LEAST_USED' THEN ${SENT_24H} ELSE 0 END,
                a.last_sent_at ASC NULLS FIRST,
                a.id ASC
            LIMIT 1
            FOR UPDATE OF a SKIP LOCKED
        `;
        const account = rows[0];
        if (!account) {
            return null;
        }

        await tx.$executeRaw`UPDATE email_accounts SET last_sent_at = ${DB_NOW} WHERE id = ${account.id}`;
        await tx.$executeRaw`
            UPDATE send_logs
            SET email_account_id = ${account.id},
                group_id = ${account.groupId},
                from_address = ${account.email},
                attempted_at = ${DB_NOW},
                locked_at = ${DB_NOW},
                status = 'SENDING',
                attempts = attempts + 1
            WHERE id = ${logId}::uuid
        `;
        return account;
    });
}

interface DiagnoseRow {
    total: number;
    capable: number;
    fitRecipients: number;
    underQuota: number;
    maxRecipients: number | null;
}

/**
 * 分析没有可用账号的原因。
 */
async function diagnoseNoSender(options: PickOptions): Promise<{ reason: NoSenderReason; message: string; retryable: boolean; maxRecipients?: number }> {
    const conditions: Prisma.Sql[] = [
        Prisma.sql`a.status = 'ACTIVE'`,
        Prisma.sql`g.send_enabled = true`,
        ...scopeConditions(options.scope),
    ];
    if (options.preferredAddress) {
        conditions.push(Prisma.sql`lower(a.email) = lower(${options.preferredAddress})`);
    }

    const [row] = await prisma.$queryRaw<DiagnoseRow[]>`
        SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE ${EFFECTIVE_SEND_CAPABILITY_SQL} <> 'DENIED')::int AS capable,
            count(*) FILTER (WHERE ${EFFECTIVE_SEND_CAPABILITY_SQL} <> 'DENIED' AND g.send_max_recipients >= ${options.recipientCount})::int AS "fitRecipients",
            count(*) FILTER (
                WHERE ${EFFECTIVE_SEND_CAPABILITY_SQL} <> 'DENIED'
                  AND g.send_max_recipients >= ${options.recipientCount}
                  AND ${SENT_24H} < g.send_daily_limit
            )::int AS "underQuota",
            max(g.send_max_recipients)::int AS "maxRecipients"
        FROM email_accounts a
        JOIN email_groups g ON g.id = a.group_id
        WHERE ${Prisma.join(conditions, ' AND ')}
    `;

    if (!row || row.total === 0) {
        if (options.preferredAddress) {
            return {
                reason: 'FROM_NOT_IN_POOL',
                message: `The \`${options.preferredAddress}\` account is not available for sending: it must be active, in a group with sending enabled, and within this API key's scope.`,
                retryable: false,
            };
        }
        return {
            reason: 'NO_POOL',
            message: 'No sending accounts are available for this API key. Enable sending on an email group in the admin console, and make sure the group is within the API key scope.',
            retryable: false,
        };
    }
    if (row.capable === 0) {
        return {
            reason: 'NO_PERMISSION',
            message: 'None of the available sending accounts can send: Microsoft Graph needs the Mail.Send permission, SMTP needs the SMTP.Send permission with SMTP AUTH enabled for the mailbox.',
            retryable: false,
        };
    }
    if (row.fitRecipients === 0) {
        return {
            reason: 'TOO_MANY_RECIPIENTS',
            message: `Too many recipients. The sending group allows at most ${row.maxRecipients ?? 0} recipients (to + cc + bcc) per email.`,
            retryable: false,
            maxRecipients: row.maxRecipients ?? 0,
        };
    }
    if (row.underQuota === 0) {
        return {
            reason: 'DAILY_QUOTA',
            message: 'All sending accounts have reached their daily sending quota. Try again later.',
            retryable: true,
        };
    }
    return {
        reason: 'RATE_LIMITED',
        message: 'All sending accounts are cooling down or within the minimum sending interval. Try again later.',
        retryable: true,
    };
}

/**
 * 把一次失败记到账号上：markDenied 时把对应通道标记为不可发信；applyCooldown 时按失败类型冷却。
 * channel 为 null 表示与通道无关（如解密失败）。
 */
async function applyFailureToAccount(accountId: number, failure: SendFailure, channel: SendChannel | null, applyCooldown: boolean = true) {
    const data: Prisma.EmailAccountUpdateInput = {
        sendErrorMessage: `${failure.graphCode}: ${failure.message}`.slice(0, 1000),
    };
    if (failure.markDenied && channel) {
        if (channel === 'SMTP') {
            data.smtpCapability = 'DENIED';
        } else {
            data.sendCapability = 'DENIED';
        }
        data.sendCheckedAt = new Date();
    }
    if (applyCooldown && failure.cooldownSeconds > 0) {
        data.sendCooldownUntil = new Date(Date.now() + failure.cooldownSeconds * 1000);
    }
    await prisma.emailAccount.update({ where: { id: accountId }, data });
}

function isRetryableKind(kind: SendFailureKind): boolean {
    return kind === 'THROTTLED' || kind === 'BLOCKED' || kind === 'TRANSIENT' || kind === 'AUTH';
}

type AttemptAccount = Pick<PickedAccount, 'id' | 'email' | 'clientId' | 'refreshToken' | 'imapClientId' | 'imapRefreshToken' | 'sendCapability' | 'smtpCapability' | 'oauthTenant' | 'sendTransport'>;
type SendCredentials = Parameters<typeof mailService.getGraphSendToken>[0];
type ChannelResult = { ok: true } | { ok: false; failure: SendFailure };

function tokenFailure(code: string, message: string): SendFailure {
    return {
        kind: 'AUTH', cooldownSeconds: TOKEN_FAILURE_COOLDOWN_SECONDS, retryOtherAccount: true, markDenied: false,
        graphCode: code, message,
    };
}

/** Graph：获取令牌 → 检查 Mail.Send → POST /me/sendMail（自定义发件人名称会被微软忽略） */
async function attemptGraph(account: AttemptAccount, credentials: SendCredentials, request: NormalizedSendRequest): Promise<ChannelResult> {
    const token = await mailService.getGraphSendToken(credentials);
    if ('error' in token) {
        return { ok: false, failure: tokenFailure('TOKEN_FAILED', token.error) };
    }
    if (!token.hasMailSend) {
        return {
            ok: false,
            failure: {
                kind: 'PERMISSION', cooldownSeconds: 0, retryOtherAccount: true, markDenied: true,
                graphCode: 'MAIL_SEND_SCOPE_MISSING', message: 'Access token does not include the Mail.Send permission',
            },
        };
    }

    const result = await mailService.sendMailViaGraph(token.accessToken, buildGraphSendPayload(request, account.email));
    if (result.ok) {
        return { ok: true };
    }
    const failure = classifyGraphSendError(result.status, result.bodyText, result.retryAfter);
    if (failure.kind === 'AUTH') {
        // 令牌可能已失效，清除缓存以便下次重新获取
        await mailService.clearGraphSendToken(account.email);
    }
    logger.warn({ accountId: account.id, kind: failure.kind, code: failure.graphCode }, 'Graph sendMail failed');
    return { ok: false, failure };
}

/** SMTP：获取令牌 → 检查 SMTP.Send → smtp-mail.outlook.com:587 XOAUTH2 提交（保留发件人名称） */
async function attemptSmtp(account: AttemptAccount, credentials: SendCredentials, request: NormalizedSendRequest): Promise<ChannelResult> {
    const token = await mailService.getSmtpSendToken(credentials);
    if ('error' in token) {
        return { ok: false, failure: tokenFailure('SMTP_TOKEN_FAILED', token.error) };
    }
    if (!token.hasSmtpSend) {
        return {
            ok: false,
            failure: {
                kind: 'PERMISSION', cooldownSeconds: 0, retryOtherAccount: true, markDenied: true,
                graphCode: 'SMTP_SEND_SCOPE_MISSING', message: 'Access token does not include the SMTP.Send permission',
            },
        };
    }

    const result = await mailService.sendMailViaSmtp(
        token.accessToken,
        { email: account.email, oauthTenant: account.oauthTenant },
        buildSmtpMessage(request, account.email)
    );
    if (result.ok) {
        return { ok: true };
    }
    const failure = classifySmtpSendError(result.error);
    if (failure.kind === 'AUTH' || failure.kind === 'PERMISSION') {
        await mailService.clearSmtpSendToken(account.email);
    }
    logger.warn({ accountId: account.id, kind: failure.kind, code: failure.graphCode }, 'SMTP send failed');
    return { ok: false, failure };
}

/**
 * 用指定账号尝试发出一次：按分组发信通道依次尝试 SMTP / Graph。
 * 某通道因权限、令牌或连接问题失败时改用另一通道；成功时之前失败的通道只记录权限结果，不让账号进入冷却。
 */
async function attemptWithAccount(
    account: AttemptAccount,
    request: NormalizedSendRequest
): Promise<{ ok: true; transport: SendTransportUsed } | { ok: false; failure: SendFailure; transport: SendChannel | null }> {
    let refreshToken: string;
    let imapRefreshToken: string | null;
    try {
        refreshToken = decrypt(account.refreshToken);
        imapRefreshToken = account.imapRefreshToken ? decrypt(account.imapRefreshToken) : null;
    } catch {
        const failure: SendFailure = tokenFailure('DECRYPT_FAILED', 'Failed to decrypt refresh token');
        await applyFailureToAccount(account.id, failure, null);
        return { ok: false, failure, transport: null };
    }

    const credentials = {
        id: account.id,
        email: account.email,
        clientId: account.clientId,
        refreshToken,
        imapClientId: account.imapClientId,
        imapRefreshToken,
        autoAssigned: false,
        oauthTenant: account.oauthTenant,
    } as SendCredentials;

    const mode = normalizeSendTransport(account.sendTransport);
    const order = resolveChannelOrder(mode, !!request.fromName, { graph: account.sendCapability, smtp: account.smtpCapability });
    const failures: Array<{ channel: SendChannel; failure: SendFailure }> = [];

    for (const channel of order) {
        const result = channel === 'SMTP'
            ? await attemptSmtp(account, credentials, request)
            : await attemptGraph(account, credentials, request);

        if (result.ok) {
            for (const item of failures) {
                await applyFailureToAccount(account.id, item.failure, item.channel, false);
            }
            const previous = channel === 'SMTP' ? account.smtpCapability : account.sendCapability;
            await prisma.emailAccount.update({
                where: { id: account.id },
                data: {
                    ...(channel === 'SMTP' ? { smtpCapability: 'ALLOWED' as const } : { sendCapability: 'ALLOWED' as const }),
                    ...(previous !== 'ALLOWED' ? { sendCheckedAt: new Date() } : {}),
                    ...(failures.length === 0 ? { sendErrorMessage: null } : {}),
                },
            });
            // 自动模式下填了发件人名称却走了 Graph：名称不会生效，记录下来便于排查
            const transport: SendTransportUsed = channel === 'GRAPH' && mode === 'AUTO' && request.fromName ? 'GRAPH_FALLBACK' : channel;
            return { ok: true, transport };
        }

        failures.push({ channel, failure: result.failure });
        if (!shouldTryNextChannel(result.failure)) {
            break;
        }
    }

    // 全部失败：最后一次失败决定账号冷却，其余只记录权限结果；请求本身的错误不影响账号
    const last = failures[failures.length - 1];
    for (const item of failures) {
        if (item.failure.kind === 'REQUEST') continue;
        await applyFailureToAccount(account.id, item.failure, item.channel, item === last);
    }
    return { ok: false, failure: last.failure, transport: last.channel };
}

async function markLogSent(logId: string, transport: SendTransportUsed) {
    await prisma.$executeRaw`
        UPDATE send_logs
        SET status = 'SENT', sent_at = ${DB_NOW}, locked_at = NULL, next_attempt_at = NULL,
            error_code = NULL, error_message = NULL, transport = ${transport}
        WHERE id = ${logId}::uuid
    `;
}

async function markLogFailed(logId: string, code: string, message: string, transport: SendChannel | null = null) {
    await prisma.sendLog.update({
        where: { id: logId },
        data: {
            status: 'FAILED',
            errorCode: code.slice(0, 64),
            errorMessage: message.slice(0, 2000),
            lockedAt: null,
            nextAttemptAt: null,
            ...(transport ? { transport } : {}),
        },
    });
}

/**
 * 从池中挑号发送已创建的发信记录。最多换 MAX_ACCOUNT_ATTEMPTS 个账号。
 * 结束时记录状态为 SENT / FAILED；未分配到任何账号时记录状态保持不变，由调用方决定删除或重新排队。
 */
export async function sendFromPool(
    logId: string,
    request: NormalizedSendRequest,
    options: {
        scope: SendScope;
        preferredAddress?: string;
        /** 失败时是否把记录标记为 FAILED（排队邮件由调用方决定是否重新排队） */
        markFailed?: boolean;
    }
): Promise<SendOutcome> {
    const excludeIds: number[] = [];
    let lastFailure: SendFailure | null = null;
    let lastTransport: SendChannel | null = null;
    let attempts = 0;

    while (attempts < MAX_ACCOUNT_ATTEMPTS) {
        const pickOptions: PickOptions = {
            scope: options.scope,
            recipientCount: request.recipientCount,
            preferredAddress: options.preferredAddress,
            excludeIds,
        };
        const account = await pickAndReserveSender(logId, pickOptions);
        if (!account) {
            if (attempts === 0) {
                const diagnosis = await diagnoseNoSender(pickOptions);
                return {
                    ok: false, logId, attempts, noAttempt: true,
                    reason: diagnosis.reason, message: diagnosis.message, retryable: diagnosis.retryable,
                    maxRecipients: diagnosis.maxRecipients,
                };
            }
            break;
        }

        attempts++;
        excludeIds.push(account.id);
        const result = await attemptWithAccount(account, request);
        if (result.ok) {
            await markLogSent(logId, result.transport);
            return { ok: true, logId, accountId: account.id, fromAddress: account.email, attempts, transport: result.transport };
        }

        lastFailure = result.failure;
        lastTransport = result.transport;
        if (!result.failure.retryOtherAccount || options.preferredAddress) {
            break;
        }
    }

    const failure = lastFailure!;
    if (options.markFailed !== false || !isRetryableKind(failure.kind)) {
        await markLogFailed(logId, failure.graphCode, failure.message, lastTransport);
    }
    return {
        ok: false, logId, attempts, noAttempt: false,
        reason: failure.kind,
        message: failure.message,
        retryable: isRetryableKind(failure.kind),
    };
}

/**
 * 发信池容量（用于批量请求的预检查）：可用账号数与最大收件人上限。
 */
export async function getPoolCapacity(scope: SendScope): Promise<{ senders: number; maxRecipients: number }> {
    const conditions: Prisma.Sql[] = [
        Prisma.sql`a.status = 'ACTIVE'`,
        Prisma.sql`g.send_enabled = true`,
        Prisma.sql`${EFFECTIVE_SEND_CAPABILITY_SQL} <> 'DENIED'`,
        ...scopeConditions(scope),
    ];
    const [row] = await prisma.$queryRaw<Array<{ senders: number; maxRecipients: number | null }>>`
        SELECT count(*)::int AS senders, max(g.send_max_recipients)::int AS "maxRecipients"
        FROM email_accounts a
        JOIN email_groups g ON g.id = a.group_id
        WHERE ${Prisma.join(conditions, ' AND ')}
    `;
    return { senders: row?.senders ?? 0, maxRecipients: row?.maxRecipients ?? 0 };
}

/**
 * 查找 from 地址对应的发信池账号（Key 范围内、所在分组已开启发信）；没有返回 undefined（此时从池中挑号）。
 */
export async function resolvePreferredSender(address: string, scope: SendScope): Promise<string | undefined> {
    const account = await prisma.emailAccount.findFirst({
        where: { email: { equals: address, mode: 'insensitive' }, group: { sendEnabled: true } },
        select: { id: true, email: true, groupId: true },
    });
    if (!account) return undefined;
    if (scope.allowedGroupIds && (!account.groupId || !scope.allowedGroupIds.includes(account.groupId))) return undefined;
    if (scope.allowedEmailIds && !scope.allowedEmailIds.includes(account.id)) return undefined;
    return account.email;
}

/**
 * 用指定账号直接发送（后台测试发信）：不检查分组开关、间隔与额度，但计入发信记录。
 */
export async function sendWithAccount(logId: string, accountId: number, request: NormalizedSendRequest): Promise<SendOutcome> {
    const account = await prisma.emailAccount.findUnique({
        where: { id: accountId },
        select: {
            id: true, email: true, clientId: true, refreshToken: true, imapClientId: true, imapRefreshToken: true,
            sendCapability: true, smtpCapability: true, groupId: true,
            group: { select: { oauthTenant: true, sendTransport: true } },
        },
    });
    if (!account) {
        await markLogFailed(logId, 'NOT_FOUND', 'Email account not found');
        return { ok: false, logId, attempts: 0, noAttempt: true, reason: 'NO_POOL', message: 'Email account not found', retryable: false };
    }

    await prisma.$executeRaw`UPDATE email_accounts SET last_sent_at = ${DB_NOW} WHERE id = ${account.id}`;
    await prisma.$executeRaw`
        UPDATE send_logs
        SET email_account_id = ${account.id}, group_id = ${account.groupId}, from_address = ${account.email},
            attempted_at = ${DB_NOW}, locked_at = ${DB_NOW}, status = 'SENDING', attempts = attempts + 1
        WHERE id = ${logId}::uuid
    `;

    const result = await attemptWithAccount({
        ...account,
        oauthTenant: account.group?.oauthTenant ?? null,
        sendTransport: account.group?.sendTransport ?? null,
    }, request);
    if (result.ok) {
        await markLogSent(logId, result.transport);
        return { ok: true, logId, accountId: account.id, fromAddress: account.email, attempts: 1, transport: result.transport };
    }
    await markLogFailed(logId, result.failure.graphCode, result.failure.message, result.transport);
    return {
        ok: false, logId, attempts: 1, noAttempt: false,
        reason: result.failure.kind, message: result.failure.message, retryable: false,
    };
}

export interface SendCheckResult {
    id: number;
    email: string;
    /** 按所在分组发信通道得出的有效结果 */
    capability: CapabilityValue;
    graph: CapabilityValue;
    smtp: CapabilityValue;
    message: string;
}

/**
 * 检测账号的发信能力（强制重新获取令牌）：
 *   Graph：令牌是否包含 Mail.Send；
 *   SMTP：令牌是否包含 SMTP.Send，并实际连接 SMTP 完成 XOAUTH2 认证（不发信），可发现邮箱禁用了 SMTP AUTH。
 */
export async function checkSendCapability(accountId: number): Promise<SendCheckResult> {
    const account = await prisma.emailAccount.findUnique({
        where: { id: accountId },
        select: {
            id: true, email: true, clientId: true, refreshToken: true, imapClientId: true, imapRefreshToken: true,
            group: { select: { oauthTenant: true, sendTransport: true } },
        },
    });
    if (!account) {
        return { id: accountId, email: '', capability: 'UNKNOWN', graph: 'UNKNOWN', smtp: 'UNKNOWN', message: 'Email account not found' };
    }

    let refreshToken: string;
    let imapRefreshToken: string | null;
    try {
        refreshToken = decrypt(account.refreshToken);
        imapRefreshToken = account.imapRefreshToken ? decrypt(account.imapRefreshToken) : null;
    } catch {
        return { id: account.id, email: account.email, capability: 'UNKNOWN', graph: 'UNKNOWN', smtp: 'UNKNOWN', message: 'Failed to decrypt refresh token' };
    }

    const oauthTenant = account.group?.oauthTenant ?? null;
    const credentials = {
        id: account.id, email: account.email, clientId: account.clientId, refreshToken,
        imapClientId: account.imapClientId, imapRefreshToken, autoAssigned: false, oauthTenant,
    } as SendCredentials;
    const notes: string[] = [];

    let graph: CapabilityValue = 'UNKNOWN';
    const graphToken = await mailService.getGraphSendToken(credentials, { force: true });
    if ('error' in graphToken) {
        notes.push(`Graph: ${graphToken.error}`);
    } else {
        graph = graphToken.hasMailSend ? 'ALLOWED' : 'DENIED';
        if (!graphToken.hasMailSend) notes.push('Graph: access token does not include the Mail.Send permission');
    }

    let smtp: CapabilityValue = 'UNKNOWN';
    const smtpToken = await mailService.getSmtpSendToken(credentials, { force: true });
    if ('error' in smtpToken) {
        notes.push(`SMTP: ${smtpToken.error}`);
    } else if (!smtpToken.hasSmtpSend) {
        smtp = 'DENIED';
        notes.push('SMTP: access token does not include the SMTP.Send permission');
    } else {
        const verify = await mailService.sendMailViaSmtp(smtpToken.accessToken, { email: account.email, oauthTenant }, null);
        if (verify.ok) {
            smtp = 'ALLOWED';
        } else {
            const failure = classifySmtpSendError(verify.error);
            if (failure.kind === 'PERMISSION') smtp = 'DENIED';
            if (failure.kind === 'AUTH' || failure.kind === 'PERMISSION') await mailService.clearSmtpSendToken(account.email);
            notes.push(`SMTP: ${failure.graphCode}: ${failure.message}`);
        }
    }

    await prisma.emailAccount.update({
        where: { id: account.id },
        data: {
            ...(graph !== 'UNKNOWN' ? { sendCapability: graph } : {}),
            ...(smtp !== 'UNKNOWN' ? { smtpCapability: smtp } : {}),
            sendCheckedAt: new Date(),
            sendErrorMessage: notes.length > 0 ? notes.join('; ').slice(0, 1000) : null,
        },
    });

    return {
        id: account.id,
        email: account.email,
        capability: effectiveSendCapability(account.group?.sendTransport, graph, smtp),
        graph,
        smtp,
        message: notes.length > 0 ? notes.join('; ') : 'OK',
    };
}

/** 发信记录中保存的地址 JSON → MailAddress[] */
export function addressesFromJson(value: Prisma.JsonValue | null): MailAddress[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is Prisma.JsonObject => !!item && typeof item === 'object' && !Array.isArray(item))
        .filter((item) => typeof item.address === 'string')
        .map((item) => (typeof item.name === 'string' && item.name ? { address: item.address as string, name: item.name } : { address: item.address as string }));
}

/**
 * 由发信记录重建发信请求（排队邮件使用；排队邮件不含附件）。
 */
export function requestFromLog(log: {
    toAddresses: Prisma.JsonValue;
    ccAddresses: Prisma.JsonValue | null;
    bccAddresses: Prisma.JsonValue | null;
    replyTo: Prisma.JsonValue | null;
    subject: string;
    html: string | null;
    text: string | null;
    headers: Prisma.JsonValue | null;
    fromName: string | null;
    recipientCount: number;
}): NormalizedSendRequest {
    const headers = Array.isArray(log.headers)
        ? log.headers
            .filter((item): item is Prisma.JsonObject => !!item && typeof item === 'object' && !Array.isArray(item))
            .filter((item) => typeof item.name === 'string' && typeof item.value === 'string')
            .map((item) => ({ name: item.name as string, value: item.value as string }))
        : [];
    return {
        to: addressesFromJson(log.toAddresses),
        cc: addressesFromJson(log.ccAddresses),
        bcc: addressesFromJson(log.bccAddresses),
        replyTo: addressesFromJson(log.replyTo),
        subject: log.subject,
        html: log.html,
        text: log.text,
        attachments: [],
        attachmentBytes: 0,
        headers,
        fromName: log.fromName ?? undefined,
        saveToSentItems: true,
        recipientCount: log.recipientCount,
    };
}
