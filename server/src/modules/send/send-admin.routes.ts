/**
 * 后台在线发信：
 *   GET  /admin/send/senders   可选发件账号（搜索 / 按分组），附带 24 小时发信量与冷却状态
 *   POST /admin/send/compose   写信发送：从分组发信池挑号，或指定账号发送
 * 发信记录 source = ADMIN，计入账号 24 小时发信量。
 */
import { randomUUID } from 'node:crypto';
import { type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../plugins/error.js';
import {
    SEND_ATTACHMENT_MAX_COUNT,
    SendRequestError,
    normalizeSendRequest,
    type NormalizedSendRequest,
} from '../../lib/send-mail.js';
import { sendFromPool, sendWithAccount, type SendOutcome, type SendScope } from './send.service.js';

const DB_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
/** 3 MB 附件 base64 后约 4 MB，再加正文 */
const COMPOSE_BODY_LIMIT = 8 * 1024 * 1024;

const addressList = (max: number) => z.array(z.string().trim().min(1).max(320)).max(max).optional();

const composeSchema = z.object({
    mode: z.enum(['POOL', 'ACCOUNT']),
    /** POOL：限定分组；不传表示所有已开启发信的分组 */
    groupId: z.number().int().positive().optional(),
    /** ACCOUNT：指定发件账号 */
    accountId: z.number().int().positive().optional(),
    fromName: z.string().trim().max(100).optional(),
    to: z.array(z.string().trim().min(1).max(320)).min(1, '至少填写一个收件人').max(50),
    cc: addressList(50),
    bcc: addressList(50),
    replyTo: addressList(10),
    subject: z.string().trim().min(1, '请填写主题').max(998),
    html: z.string().max(2_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    attachments: z.array(z.object({
        filename: z.string().min(1).max(255),
        content: z.string().min(1),
        contentType: z.string().max(255).optional(),
    })).max(SEND_ATTACHMENT_MAX_COUNT).optional(),
}).superRefine((value, ctx) => {
    if (value.mode === 'ACCOUNT' && !value.accountId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accountId'], message: '请选择发件账号' });
    }
});

const sendersSchema = z.object({
    keyword: z.string().trim().max(200).optional(),
    groupId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface SenderRow {
    id: number;
    email: string;
    sendCapability: 'UNKNOWN' | 'ALLOWED' | 'DENIED';
    sendCooldownUntil: Date | null;
    lastSentAt: Date | null;
    sendErrorMessage: string | null;
    groupId: number | null;
    groupName: string | null;
    sendEnabled: boolean | null;
    sendDailyLimit: number | null;
    sent24h: number;
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function outcomeMessage(outcome: Extract<SendOutcome, { ok: false }>): string {
    switch (outcome.reason) {
        case 'NO_POOL':
            return '没有可用的发信账号：请确认分组已开启发信，且组内有正常状态的账号';
        case 'NO_PERMISSION':
            return '可用账号都没有 Mail.Send 发信权限';
        case 'TOO_MANY_RECIPIENTS':
            return `收件人太多：分组每封最多 ${outcome.maxRecipients ?? 0} 个收件人（收件人 + 抄送 + 密送）`;
        case 'DAILY_QUOTA':
            return '发信池账号的 24 小时额度都已用完，请稍后再试';
        case 'RATE_LIMITED':
            return '发信池账号都在冷却或发信间隔内，请稍后再试';
        case 'THROTTLED':
        case 'BLOCKED':
            return `微软限制了发信：${outcome.message}`;
        case 'PERMISSION':
            return `账号没有发信权限：${outcome.message}`;
        case 'AUTH':
            return `获取访问令牌失败：${outcome.message}`;
        case 'REQUEST':
            return `微软拒绝了这封邮件：${outcome.message}`;
        default:
            return outcome.message;
    }
}

const sendAdminRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', fastify.authenticateJwt);

    // 可选发件账号
    fastify.get('/senders', async (request) => {
        const input = sendersSchema.parse(request.query);
        const conditions: Prisma.Sql[] = [
            Prisma.sql`a.status = 'ACTIVE'`,
            Prisma.sql`a.send_capability <> 'DENIED'`,
        ];
        if (input.groupId) {
            conditions.push(Prisma.sql`a.group_id = ${input.groupId}`);
        }
        if (input.keyword) {
            conditions.push(Prisma.sql`a.email ILIKE ${`%${escapeLike(input.keyword)}%`}`);
        }

        const rows = await prisma.$queryRaw<SenderRow[]>`
            SELECT a.id, a.email,
                   a.send_capability::text AS "sendCapability",
                   a.send_cooldown_until AS "sendCooldownUntil",
                   a.last_sent_at AS "lastSentAt",
                   a.send_error_message AS "sendErrorMessage",
                   g.id AS "groupId", g.name AS "groupName",
                   g.send_enabled AS "sendEnabled",
                   g.send_daily_limit AS "sendDailyLimit",
                   (
                       SELECT count(*)::int FROM send_logs l
                       WHERE l.email_account_id = a.id
                         AND l.status IN ('SENT', 'SENDING')
                         AND l.attempted_at > ${DB_NOW} - interval '24 hours'
                   ) AS "sent24h"
            FROM email_accounts a
            LEFT JOIN email_groups g ON g.id = a.group_id
            WHERE ${Prisma.join(conditions, ' AND ')}
            ORDER BY (a.send_capability = 'ALLOWED') DESC, a.id ASC
            LIMIT ${input.limit}
        `;
        return { success: true, data: rows };
    });

    // 写信发送
    fastify.post('/compose', { bodyLimit: COMPOSE_BODY_LIMIT }, async (request) => {
        const input = composeSchema.parse(request.body);

        let normalized: NormalizedSendRequest;
        try {
            normalized = normalizeSendRequest({
                to: input.to,
                cc: input.cc,
                bcc: input.bcc,
                replyTo: input.replyTo,
                subject: input.subject,
                html: input.html,
                text: input.text,
                fromName: input.fromName,
                attachments: input.attachments?.map((item) => ({
                    filename: item.filename,
                    content: item.content,
                    contentType: item.contentType,
                })),
            });
        } catch (err) {
            if (err instanceof SendRequestError) {
                throw new AppError('VALIDATION_ERROR', err.message, 400);
            }
            throw err;
        }

        let requestedFrom: string;
        let account: { id: number; email: string; sendCapability: string } | null = null;
        let groupName: string | null = null;

        if (input.mode === 'ACCOUNT') {
            account = await prisma.emailAccount.findUnique({
                where: { id: input.accountId! },
                select: { id: true, email: true, sendCapability: true, status: true },
            });
            if (!account) {
                throw new AppError('NOT_FOUND', '发件账号不存在', 404);
            }
            if (account.sendCapability === 'DENIED') {
                throw new AppError('SEND_PERMISSION_MISSING', '该账号没有 Mail.Send 发信权限，请先重新检测或换一个账号', 400);
            }
            requestedFrom = account.email;
        } else {
            if (input.groupId) {
                const group = await prisma.emailGroup.findUnique({
                    where: { id: input.groupId },
                    select: { id: true, name: true, sendEnabled: true },
                });
                if (!group) {
                    throw new AppError('GROUP_NOT_FOUND', '分组不存在', 404);
                }
                if (!group.sendEnabled) {
                    throw new AppError('SEND_NOT_ENABLED', `分组「${group.name}」没有开启发信`, 400);
                }
                groupName = group.name;
            }
            requestedFrom = `发信池${groupName ? `（${groupName}）` : '（全部分组）'}`;
        }

        const logId = randomUUID();
        await prisma.sendLog.create({
            data: {
                id: logId,
                source: 'ADMIN',
                status: 'QUEUED',
                adminId: request.user?.id ?? null,
                requestedFrom,
                fromName: normalized.fromName ?? null,
                toAddresses: normalized.to as unknown as Prisma.InputJsonValue,
                ccAddresses: normalized.cc.length > 0 ? normalized.cc as unknown as Prisma.InputJsonValue : undefined,
                bccAddresses: normalized.bcc.length > 0 ? normalized.bcc as unknown as Prisma.InputJsonValue : undefined,
                replyTo: normalized.replyTo.length > 0 ? normalized.replyTo as unknown as Prisma.InputJsonValue : undefined,
                subject: normalized.subject,
                html: normalized.html,
                text: normalized.text,
                recipientCount: normalized.recipientCount,
                attachmentCount: normalized.attachments.length,
                attachmentBytes: normalized.attachmentBytes,
                requestIp: request.ip,
            },
        });

        const scope: SendScope = input.groupId ? { allowedGroupIds: [input.groupId] } : {};
        const outcome = account
            ? await sendWithAccount(logId, account.id, normalized)
            : await sendFromPool(logId, normalized, { scope });

        if (!outcome.ok && outcome.noAttempt) {
            // 没有分配到账号：不留下记录
            await prisma.sendLog.deleteMany({ where: { id: logId } });
        }

        request.log.info({
            systemEvent: true,
            action: 'send.compose',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            mode: input.mode,
            groupId: input.groupId ?? null,
            accountId: outcome.ok ? outcome.accountId : account?.id ?? null,
            recipientCount: normalized.recipientCount,
            attachmentCount: normalized.attachments.length,
            success: outcome.ok,
        }, outcome.ok ? '在线发信成功' : '在线发信失败');

        if (outcome.ok) {
            return {
                success: true,
                data: {
                    sent: true,
                    logId,
                    fromAddress: outcome.fromAddress,
                    attempts: outcome.attempts,
                    message: 'Microsoft Graph 已接收这封邮件',
                    reason: null,
                },
            };
        }
        return {
            success: true,
            data: {
                sent: false,
                logId: outcome.noAttempt ? null : logId,
                fromAddress: null,
                attempts: outcome.attempts,
                message: outcomeMessage(outcome),
                reason: outcome.reason,
            },
        };
    });
};

export default sendAdminRoutes;
