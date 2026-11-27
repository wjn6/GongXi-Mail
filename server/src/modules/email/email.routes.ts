import { type FastifyPluginAsync } from 'fastify';
import { emailService } from './email.service.js';
import { mailService } from '../mail/mail.service.js';
import { tokenRefreshService } from './token-refresh.service.js';
import { createEmailSchema, updateEmailSchema, listEmailSchema, importEmailSchema } from './email.schema.js';
import { z } from 'zod';
import { AppError } from '../../plugins/error.js';
import { getTokenRefreshJobNextRunAt, refreshTokenRefreshJobSchedule } from '../../jobs/token-refresh.js';
import { randomUUID } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { SendRequestError, normalizeSendRequest } from '../../lib/send-mail.js';
import { checkSendCapability, sendWithAccount } from '../send/send.service.js';

const CHECK_SEND_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

const emailRoutes: FastifyPluginAsync = async (fastify) => {
    // 所有路由需要 JWT 认证
    fastify.addHook('preHandler', fastify.authenticateJwt);

    // 列表
    fastify.get('/', async (request) => {
        const input = listEmailSchema.parse(request.query);
        const result = await emailService.list(input);
        return { success: true, data: result };
    });

    // 详情
    fastify.get('/:id', async (request) => {
        const { id } = request.params as { id: string };
        const { secrets } = request.query as { secrets?: string };
        // 含密钥的详情仅超级管理员可见
        if (secrets === 'true' && request.user?.role !== 'SUPER_ADMIN') {
            throw new AppError('FORBIDDEN', 'Super admin access required', 403);
        }
        const email = await emailService.getById(parseInt(id), secrets === 'true');
        return { success: true, data: email };
    });

    // 创建
    fastify.post('/', async (request) => {
        const input = createEmailSchema.parse(request.body);
        const email = await emailService.create(input);
        request.log.info({
            systemEvent: true,
            action: 'email.create',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            emailId: email.id,
            email: email.email,
        }, '新增邮箱');
        return { success: true, data: email };
    });

    // 更新
    fastify.put('/:id', async (request) => {
        const { id } = request.params as { id: string };
        const input = updateEmailSchema.parse(request.body);
        const email = await emailService.update(parseInt(id), input);
        request.log.info({
            systemEvent: true,
            action: 'email.update',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            emailId: email.id,
            email: email.email,
            status: email.status,
        }, '修改邮箱');
        return { success: true, data: email };
    });

    // 删除
    fastify.delete('/:id', async (request) => {
        const { id } = request.params as { id: string };
        await emailService.delete(parseInt(id));
        request.log.info({
            systemEvent: true,
            action: 'email.delete',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            emailId: parseInt(id),
        }, '删除邮箱');
        return { success: true, data: { message: 'Email account deleted' } };
    });

    // 批量删除
    fastify.post('/batch-delete', async (request) => {
        const { ids } = z.object({ ids: z.array(z.number()) }).parse(request.body);
        const result = await emailService.batchDelete(ids);
        request.log.info({
            systemEvent: true,
            action: 'email.batch_delete',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            emailIds: ids,
            deletedCount: result.deleted,
        }, '批量删除邮箱');
        return { success: true, data: result };
    });

    // 批量导入
    fastify.post('/import', async (request) => {
        const input = importEmailSchema.parse(request.body);
        const result = await emailService.import(input);
        request.log.info({
            systemEvent: true,
            action: 'email.import',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            separator: input.separator,
            success: result.success,
            failed: result.failed,
            errorCount: result.errors.length,
        }, '批量导入邮箱');
        return { success: true, data: result };
    });

    // 导出（含 refresh token 明文，仅超级管理员）
    fastify.get('/export', {
        preHandler: [fastify.requireSuperAdmin],
    }, async (request) => {
        const query = z.object({
            ids: z.string().optional(),
            separator: z.string().optional(),
            groupId: z.coerce.number().int().positive().optional(),
        }).parse(request.query);

        const idArray = query.ids?.split(',').map(Number).filter((id: number) => Number.isFinite(id) && id > 0);
        const content = await emailService.export(idArray, query.separator, query.groupId);
        request.log.info({
            systemEvent: true,
            action: 'email.export',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            groupId: query.groupId ?? null,
            emailCount: idArray?.length ?? null,
        }, '导出邮箱');
        return { success: true, data: { content } };
    });

    // 查看邮件 (管理员专用)
    fastify.get('/:id/mails', async (request) => {
        const { id } = request.params as { id: string };
        const { mailbox } = request.query as { mailbox?: string };

        const emailData = await emailService.getById(parseInt(id), true);

        const credentials = {
            id: emailData.id,
            email: emailData.email,
            clientId: emailData.clientId,
            refreshToken: emailData.refreshToken!,
            imapClientId: emailData.imapClientId ?? null,
            imapRefreshToken: emailData.imapRefreshToken ?? null,
            autoAssigned: false,
            fetchStrategy: emailData.group?.fetchStrategy,
            oauthTenant: emailData.group?.oauthTenant,
        };

        const mails = await mailService.getEmails(credentials, { mailbox: mailbox || 'INBOX' });
        await emailService.touchLastCheckAt(emailData.id);
        return { success: true, data: mails };
    });

    // 清空邮箱 (管理员专用)
    fastify.post('/:id/clear', async (request) => {
        const { id } = request.params as { id: string };
        const { mailbox } = request.body as { mailbox?: string };

        const emailData = await emailService.getById(parseInt(id), true);

        const credentials = {
            id: emailData.id,
            email: emailData.email,
            clientId: emailData.clientId,
            refreshToken: emailData.refreshToken!,
            imapClientId: emailData.imapClientId ?? null,
            imapRefreshToken: emailData.imapRefreshToken ?? null,
            autoAssigned: false,
            fetchStrategy: emailData.group?.fetchStrategy,
            oauthTenant: emailData.group?.oauthTenant,
        };

        const result = await mailService.processMailbox(credentials, { mailbox: mailbox || 'INBOX' });
        await emailService.touchLastCheckAt(emailData.id);
        request.log.info({
            systemEvent: true,
            action: 'email.clear_mailbox',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            emailId: emailData.id,
            email: emailData.email,
            mailbox: mailbox || 'INBOX',
        }, '清空邮箱');
        return { success: true, data: result };
    });

    // ========================================
    // Token 刷新 - 批量刷新所有未禁用邮箱的 Token
    // ========================================
    fastify.post('/refresh-tokens', async (request) => {
        const body = z.object({
            groupId: z.number().int().positive().optional(),
        }).optional().parse(request.body);

        if (tokenRefreshService.isRefreshRunning()) {
            throw new AppError('REFRESH_IN_PROGRESS', 'Token refresh is already running', 409);
        }

        request.log.info({
            systemEvent: true,
            action: 'token_refresh.manual_request',
            trigger: 'MANUAL',
            groupId: body?.groupId ?? null,
            requestedById: request.user?.id ?? null,
            requestedByUsername: request.user?.username ?? null,
        }, '手动触发批量刷新 Token');

        // 异步执行，不阻塞请求
        void tokenRefreshService.refreshAll({
            groupId: body?.groupId,
            trigger: 'MANUAL',
            requestedBy: request.user ? {
                id: request.user.id,
                username: request.user.username,
            } : null,
        }).catch((err) => {
            request.log.error({
                err,
                systemEvent: true,
                action: 'token_refresh.manual_failed',
                trigger: 'MANUAL',
                groupId: body?.groupId ?? null,
                requestedById: request.user?.id ?? null,
                requestedByUsername: request.user?.username ?? null,
            }, '手动批量刷新 Token 失败');
        });
        return { success: true, data: { message: 'Token refresh started' } };
    });

    fastify.put('/refresh-settings', async (request) => {
        const input = z.object({
            enabled: z.boolean(),
            intervalHours: z.coerce.number().int().min(1).max(24 * 30),
            concurrency: z.coerce.number().int().min(1).max(50),
        }).parse(request.body);

        const settings = await tokenRefreshService.updateTokenRefreshConfig(input);
        await refreshTokenRefreshJobSchedule();
        request.log.info({
            systemEvent: true,
            action: 'token_refresh.settings_update',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            enabled: settings.enabled,
            intervalHours: settings.intervalHours,
            concurrency: settings.concurrency,
        }, '修改 Token 自动刷新设置');

        return { success: true, data: settings };
    });

    // ========================================
    // Token 刷新 - 单个邮箱
    // ========================================
    fastify.post('/:id/refresh-token', async (request) => {
        const { id } = request.params as { id: string };
        const result = await tokenRefreshService.refreshSingleToken(parseInt(id));
        request.log.info({
            systemEvent: true,
            action: 'token_refresh.single',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            emailId: result.emailId,
            email: result.email || null,
            success: result.success,
        }, result.success ? '手动刷新单个邮箱 Token 成功' : '手动刷新单个邮箱 Token 失败');
        return { success: true, data: result };
    });

    // ========================================
    // 发信能力检测（检查令牌是否包含 Mail.Send）
    // ========================================
    fastify.post('/check-send', async (request) => {
        const input = z.object({
            ids: z.array(z.number().int().positive()).min(1).max(200),
        }).parse(request.body);
        const ids = Array.from(new Set(input.ids));
        const results = await mapWithConcurrency(ids, CHECK_SEND_CONCURRENCY, (id) => checkSendCapability(id));
        const summary = {
            total: results.length,
            allowed: results.filter((item) => item.capability === 'ALLOWED').length,
            denied: results.filter((item) => item.capability === 'DENIED').length,
            failed: results.filter((item) => item.capability === 'UNKNOWN').length,
        };
        request.log.info({
            systemEvent: true,
            action: 'email.send_check',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            ...summary,
        }, '批量检测发信权限');
        return { success: true, data: { ...summary, results } };
    });

    fastify.post('/:id/check-send', async (request) => {
        const { id } = request.params as { id: string };
        const result = await checkSendCapability(parseInt(id));
        if (!result.email) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }
        request.log.info({
            systemEvent: true,
            action: 'email.send_check',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            emailId: result.id,
            email: result.email,
            capability: result.capability,
        }, '检测邮箱发信权限');
        return { success: true, data: result };
    });

    // ========================================
    // 测试发信（指定账号，不受分组开关 / 间隔 / 额度限制，计入发信记录）
    // ========================================
    fastify.post('/:id/test-send', async (request) => {
        const { id } = request.params as { id: string };
        const input = z.object({
            to: z.string().email(),
            subject: z.string().min(1).max(200).optional(),
            text: z.string().min(1).max(5000).optional(),
        }).parse(request.body);

        const account = await prisma.emailAccount.findUnique({
            where: { id: parseInt(id) },
            select: { id: true, email: true },
        });
        if (!account) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        let normalized;
        try {
            normalized = normalizeSendRequest({
                to: input.to,
                subject: input.subject || 'GongXi Mail 测试发信',
                text: input.text || `这是一封来自 GongXi Mail 的测试邮件，发件账号：${account.email}`,
            });
        } catch (err) {
            if (err instanceof SendRequestError) {
                throw new AppError('VALIDATION_ERROR', err.message, 400);
            }
            throw err;
        }

        const logId = randomUUID();
        await prisma.sendLog.create({
            data: {
                id: logId,
                source: 'ADMIN',
                status: 'QUEUED',
                adminId: request.user?.id ?? null,
                requestedFrom: account.email,
                toAddresses: normalized.to as unknown as object,
                subject: normalized.subject,
                text: normalized.text,
                html: normalized.html,
                recipientCount: normalized.recipientCount,
                requestIp: request.ip,
            },
        });
        const outcome = await sendWithAccount(logId, account.id, normalized);
        request.log.info({
            systemEvent: true,
            action: 'email.test_send',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            emailId: account.id,
            email: account.email,
            success: outcome.ok,
        }, outcome.ok ? '测试发信成功' : '测试发信失败');
        return {
            success: true,
            data: {
                sent: outcome.ok,
                logId,
                message: outcome.ok ? `Accepted by ${outcome.transport === 'SMTP' ? 'Outlook SMTP' : 'Microsoft Graph'}` : outcome.message,
                reason: outcome.ok ? null : outcome.reason,
                transport: outcome.ok ? outcome.transport : null,
            },
        };
    });

    // ========================================
    // Token 刷新状态查询
    // ========================================
    fastify.get('/refresh-status', async () => {
        const settings = await tokenRefreshService.getTokenRefreshConfig();
        const stats = await tokenRefreshService.getRefreshStats(getTokenRefreshJobNextRunAt());
        return {
            success: true,
            data: {
                enabled: settings.enabled,
                intervalHours: settings.intervalHours,
                concurrency: settings.concurrency,
                lastRunAt: stats.lastRunAt,
                nextRunAt: stats.nextRunAt,
                isRunning: stats.isRunning,
                lastResult: stats.lastResult ? {
                    total: stats.lastResult.total,
                    success: stats.lastResult.success,
                    failed: stats.lastResult.failed,
                    durationMs: stats.lastResult.durationMs,
                } : null,
                currentRun: stats.currentRun ? {
                    trigger: stats.currentRun.trigger,
                    total: stats.currentRun.total,
                    completed: stats.currentRun.completed,
                    success: stats.currentRun.success,
                    failed: stats.currentRun.failed,
                    groupId: stats.currentRun.groupId,
                    requestedByUsername: stats.currentRun.requestedByUsername,
                    startedAt: stats.currentRun.startedAt,
                    durationMs: stats.currentRun.durationMs,
                    recentFailures: stats.currentRun.recentFailures.slice().reverse(),
                } : null,
                recentFailures: stats.recentFailures,
            },
        };
    });
};

export default emailRoutes;
