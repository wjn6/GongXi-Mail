import { type FastifyPluginAsync } from 'fastify';
import { mailService } from './mail.service.js';
import { poolService } from './pool.service.js';
import { emailService } from '../email/email.service.js';
import { MAIL_LOG_ACTIONS } from './mail.actions.js';
import { z } from 'zod';
import { AppError } from '../../plugins/error.js';
import { isSafeUserRegex } from '../../lib/safe-regex.js';
import {
    CLAIM_LEASE_DEFAULT_SECONDS,
    CLAIM_LEASE_MAX_SECONDS,
    CLAIM_LEASE_MIN_SECONDS,
} from './pool.service.js';
import {
    WAIT_CODE_INTERVAL_DEFAULT_SECONDS,
    WAIT_CODE_INTERVAL_MAX_SECONDS,
    WAIT_CODE_INTERVAL_MIN_SECONDS,
    WAIT_CODE_TIMEOUT_DEFAULT_SECONDS,
    WAIT_CODE_TIMEOUT_MAX_SECONDS,
    WAIT_CODE_TIMEOUT_MIN_SECONDS,
    acquireWaitSlot,
    parseSinceParam,
    resolveDefaultSince,
    waitForVerificationCode,
    type WaitCodeResult,
} from '../../lib/wait-code.js';
import { logger } from '../../lib/logger.js';

/** wait_code 每轮每个文件夹拉取的最新邮件数量 */
const WAIT_CODE_FETCH_LIMIT = 10;

// /api/* 路由自带按 Key 的限流，跳过全局 IP 限流，避免双计
const apiRouteConfig = { config: { rateLimit: false } } as const;

// 邮件请求 Schema
const mailRequestSchema = z.object({
    email: z.string().email(),
    mailbox: z.string().default('inbox'),
    socks5: z.string().optional(),
    http: z.string().optional(),
});

// 纯文本邮件请求 Schema
const mailTextRequestSchema = z.object({
    email: z.string().email(),
    match: z.string().min(1).max(200).optional(), // 正则表达式 (可选)
});

// 领取邮箱（带租约）
const claimRequestSchema = z.object({
    group: z.string().min(1).optional(),
    lease: z.coerce.number().int()
        .min(CLAIM_LEASE_MIN_SECONDS)
        .max(CLAIM_LEASE_MAX_SECONDS)
        .default(CLAIM_LEASE_DEFAULT_SECONDS),
});

// 完成 / 释放领取
const claimTargetSchema = z.object({
    email: z.string().email(),
});

// 长轮询等待验证码
const waitCodeRequestSchema = z.object({
    email: z.string().email(),
    match: z.string().min(1).max(200).optional(),
    mailbox: z.string().default('all')
        .transform((value) => value.toLowerCase())
        .pipe(z.enum(['inbox', 'junk', 'all'])),
    timeout: z.coerce.number().int()
        .min(WAIT_CODE_TIMEOUT_MIN_SECONDS)
        .max(WAIT_CODE_TIMEOUT_MAX_SECONDS)
        .default(WAIT_CODE_TIMEOUT_DEFAULT_SECONDS),
    interval: z.coerce.number().int()
        .min(WAIT_CODE_INTERVAL_MIN_SECONDS)
        .max(WAIT_CODE_INTERVAL_MAX_SECONDS)
        .default(WAIT_CODE_INTERVAL_DEFAULT_SECONDS),
    since: z.union([z.string(), z.number()]).optional(),
    format: z.string().default('json')
        .transform((value) => value.toLowerCase())
        .pipe(z.enum(['json', 'text'])),
    socks5: z.string().optional(),
    http: z.string().optional(),
});

function getRequestInput(method: string, query: unknown, body: unknown): Record<string, unknown> {
    const input = method === 'GET' ? query : body;
    return input && typeof input === 'object' ? input as Record<string, unknown> : {};
}

function getErrorStatusCode(err: unknown): number {
    if (!err || typeof err !== 'object') {
        return 500;
    }

    const errorObj = err as { name?: unknown; statusCode?: unknown };
    if (errorObj.name === 'ZodError') {
        return 400;
    }
    return typeof errorObj.statusCode === 'number' ? errorObj.statusCode : 500;
}

function getErrorMessage(err: unknown): string {
    if (!err || typeof err !== 'object') {
        return 'Unknown error';
    }
    const message = (err as { message?: unknown }).message;
    return typeof message === 'string' && message.trim() ? message : 'Unknown error';
}

function hasErrorCode(err: unknown, code: string): boolean {
    if (!err || typeof err !== 'object') {
        return false;
    }
    return (err as { code?: unknown }).code === code;
}

function getGroupNameFromRequest(method: string, query: unknown, body: unknown): string | undefined {
    const params = (method === 'GET' ? query : body) as Record<string, unknown> | undefined;
    const groupName = params?.group;
    return typeof groupName === 'string' ? groupName : undefined;
}

const mailRoutes: FastifyPluginAsync = async (fastify) => {
    // 所有路由需要 API Key 认证
    fastify.addHook('preHandler', fastify.authenticateApiKey);

    // ========================================
    // 新增：获取一个未使用的邮箱地址 (带重试机制)
    // ========================================
    fastify.all('/get-email', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        try {
            if (!request.apiKey?.id) {
                throw new AppError('AUTH_REQUIRED', 'API Key required', 401);
            }
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.GET_EMAIL);

            const groupName = getGroupNameFromRequest(request.method, request.query, request.body);

            // 重试 3 次，防止并发冲突
            for (let i = 0; i < 3; i++) {
                const email = await poolService.getUnusedEmail(request.apiKey.id, groupName);
                if (!email) {
                    const stats = await poolService.getStats(request.apiKey.id, groupName);
                    throw new AppError(
                        'NO_UNUSED_EMAIL',
                        `No unused emails available${groupName ? ` in group '${groupName}'` : ''}. Used: ${stats.used}/${stats.total}`,
                        400
                    );
                }

                try {
                    await poolService.markUsed(request.apiKey.id, email.id);
                    await mailService.logApiCall(
                        MAIL_LOG_ACTIONS.GET_EMAIL,
                        request.apiKey.id,
                        email.id,
                        request.ip,
                        200,
                        Date.now() - startTime,
                        request.id
                    );
                    return {
                        success: true,
                        data: {
                            email: email.email,
                            id: email.id,
                        },
                    };
                } catch (err: unknown) {
                    if (hasErrorCode(err, 'ALREADY_USED')) {
                        continue;
                    }
                    throw err;
                }
            }

            throw new AppError('CONCURRENCY_LIMIT', 'System busy, please try again', 429);
        } catch (err: unknown) {
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.GET_EMAIL,
                request.apiKey?.id,
                undefined,
                request.ip,
                getErrorStatusCode(err),
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 获取最新邮件（必须指定 email）
    // ========================================
    fastify.all('/mail_new', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        const input = mailRequestSchema.parse(
            request.method === 'GET' ? request.query : request.body
        );

        if (!request.apiKey?.id) {
            throw new AppError('AUTH_REQUIRED', 'API Key required', 401);
        }
        fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.MAIL_NEW);

        // 查找邮箱
        const emailAccount = await emailService.getByEmail(input.email);
        if (!emailAccount) {
            throw new AppError('EMAIL_NOT_FOUND', 'Email account not found', 404);
        }
        await poolService.assertEmailAccessible(request.apiKey.id, emailAccount.id, emailAccount.groupId ?? null);

        const credentials = {
            id: emailAccount.id,
            email: emailAccount.email,
            clientId: emailAccount.clientId,
            refreshToken: emailAccount.refreshToken!,
            autoAssigned: false,
            fetchStrategy: emailAccount.fetchStrategy,
        };

        try {
            const result = await mailService.getEmails(credentials, {
                mailbox: input.mailbox,
                limit: 1,
                socks5: input.socks5,
                http: input.http,
            });

            await mailService.updateEmailStatus(credentials.id, true);

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.MAIL_NEW,
                request.apiKey.id,
                credentials.id,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            return {
                success: true,
                data: result,
                email: credentials.email,
            };
        } catch (err: unknown) {
            await mailService.updateEmailStatus(credentials.id, false, getErrorMessage(err));
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.MAIL_NEW,
                request.apiKey.id,
                credentials.id,
                request.ip,
                500,
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 新增：获取最新邮件的纯文本内容 (脚本友好)
    // ========================================
    fastify.all('/mail_text', apiRouteConfig, async (request, reply) => {
        const startTime = Date.now();
        const input = mailTextRequestSchema.parse(
            request.method === 'GET' ? request.query : request.body
        );

        if (!request.apiKey?.id) {
            reply.code(401).type('text/plain').send('Error: API Key required');
            return;
        }
        try {
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.MAIL_TEXT);
        } catch (err: unknown) {
            const message = getErrorMessage(err);
            const statusCode = getErrorStatusCode(err);
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.MAIL_TEXT,
                request.apiKey?.id,
                undefined,
                request.ip,
                statusCode,
                Date.now() - startTime,
                request.id
            );
            reply.code(statusCode).type('text/plain').send(`Error: ${message}`);
            return;
        }

        const emailAccount = await emailService.getByEmail(input.email);
        if (!emailAccount) {
            reply.code(404).type('text/plain').send('Error: Email account not found');
            return;
        }
        await poolService.assertEmailAccessible(request.apiKey.id, emailAccount.id, emailAccount.groupId ?? null);

        const credentials = {
            id: emailAccount.id,
            email: emailAccount.email,
            clientId: emailAccount.clientId,
            refreshToken: emailAccount.refreshToken!,
            autoAssigned: false,
            fetchStrategy: emailAccount.fetchStrategy,
        };

        try {
            const result = await mailService.getEmails(credentials, {
                mailbox: 'inbox',
                limit: 1, // 只取最新一封
            });

            await mailService.updateEmailStatus(credentials.id, true);
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.MAIL_TEXT,
                request.apiKey.id,
                credentials.id,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            if (!result.messages || result.messages.length === 0) {
                reply.code(404).type('text/plain').send('Error: No messages found');
                return;
            }

            const message = result.messages[0];
            // 优先使用 text 字段
            let content = message.text || '';

            // 如果指定了正则匹配
            if (input.match) {
                if (!isSafeUserRegex(input.match)) {
                    reply.code(400).type('text/plain').send('Error: Regex pattern rejected (too long or potentially catastrophic)');
                    return;
                }
                try {
                    const regex = new RegExp(input.match);
                    const match = content.match(regex);
                    if (match) {
                        // 如果有捕获组，返回第一个捕获组；否则返回整个匹配
                        content = match[1] || match[0];
                    } else {
                        reply.code(404).type('text/plain').send('Error: No match found');
                        return;
                    }
                } catch (_e) {
                    reply.code(400).type('text/plain').send('Error: Invalid regex pattern');
                    return;
                }
            }

            return reply.type('text/plain').send(content);

        } catch (err: unknown) {
            await mailService.updateEmailStatus(credentials.id, false, getErrorMessage(err));
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.MAIL_TEXT,
                request.apiKey.id,
                credentials.id,
                request.ip,
                500,
                Date.now() - startTime,
                request.id
            );
            reply.code(500).type('text/plain').send(`Error: ${getErrorMessage(err)}`);
        }
    });

    // ========================================
    // 获取所有邮件（必须指定 email）
    // ========================================
    fastify.all('/mail_all', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        const input = mailRequestSchema.parse(
            request.method === 'GET' ? request.query : request.body
        );

        if (!request.apiKey?.id) {
            throw new AppError('AUTH_REQUIRED', 'API Key required', 401);
        }
        fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.MAIL_ALL);

        const emailAccount = await emailService.getByEmail(input.email);
        if (!emailAccount) {
            throw new AppError('EMAIL_NOT_FOUND', 'Email account not found', 404);
        }
        await poolService.assertEmailAccessible(request.apiKey.id, emailAccount.id, emailAccount.groupId ?? null);

        const credentials = {
            id: emailAccount.id,
            email: emailAccount.email,
            clientId: emailAccount.clientId,
            refreshToken: emailAccount.refreshToken!,
            autoAssigned: false,
            fetchStrategy: emailAccount.fetchStrategy,
        };

        try {
            const result = await mailService.getEmails(credentials, {
                mailbox: input.mailbox,
                socks5: input.socks5,
                http: input.http,
            });

            await mailService.updateEmailStatus(credentials.id, true);

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.MAIL_ALL,
                request.apiKey.id,
                credentials.id,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            return {
                success: true,
                data: result,
                email: credentials.email,
            };
        } catch (err: unknown) {
            await mailService.updateEmailStatus(credentials.id, false, getErrorMessage(err));
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.MAIL_ALL,
                request.apiKey.id,
                credentials.id,
                request.ip,
                500,
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 清空邮箱（必须指定 email）
    // ========================================
    fastify.all('/process-mailbox', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        const input = mailRequestSchema.parse(
            request.method === 'GET' ? request.query : request.body
        );

        if (!request.apiKey?.id) {
            throw new AppError('AUTH_REQUIRED', 'API Key required', 401);
        }
        fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.PROCESS_MAILBOX);

        const emailAccount = await emailService.getByEmail(input.email);
        if (!emailAccount) {
            throw new AppError('EMAIL_NOT_FOUND', 'Email account not found', 404);
        }
        await poolService.assertEmailAccessible(request.apiKey.id, emailAccount.id, emailAccount.groupId ?? null);

        const credentials = {
            id: emailAccount.id,
            email: emailAccount.email,
            clientId: emailAccount.clientId,
            refreshToken: emailAccount.refreshToken!,
            autoAssigned: false,
            fetchStrategy: emailAccount.fetchStrategy,
        };

        try {
            const result = await mailService.processMailbox(credentials, {
                mailbox: input.mailbox,
                socks5: input.socks5,
                http: input.http,
            });

            await mailService.updateEmailStatus(credentials.id, true);

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.PROCESS_MAILBOX,
                request.apiKey.id,
                credentials.id,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            return {
                success: true,
                data: result,
                email: credentials.email,
            };
        } catch (err: unknown) {
            await mailService.updateEmailStatus(credentials.id, false, getErrorMessage(err));
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.PROCESS_MAILBOX,
                request.apiKey.id,
                credentials.id,
                request.ip,
                500,
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 列出系统 ACTIVE 邮箱（支持分组过滤）
    // ========================================
    fastify.all('/list-emails', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        try {
            if (!request.apiKey?.id) {
                throw new AppError('AUTH_REQUIRED', 'API Key required', 401);
            }
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.LIST_EMAILS);

            const groupName = getGroupNameFromRequest(request.method, request.query, request.body);

            const result = await emailService.list({ page: 1, pageSize: 1000, status: 'ACTIVE', groupName });
            const scope = await poolService.getApiKeyScope(request.apiKey.id);
            const scopedEmails = result.list.filter((emailItem: { id: number; groupId: number | null }) => {
                if (scope.allowedGroupIds && (!emailItem.groupId || !scope.allowedGroupIds.includes(emailItem.groupId))) {
                    return false;
                }
                if (scope.allowedEmailIds && !scope.allowedEmailIds.includes(emailItem.id)) {
                    return false;
                }
                return true;
            });

            const emails = scopedEmails.map((emailItem: { email: string; status: string; group?: { name: string } | null }) => ({
                email: emailItem.email,
                status: emailItem.status,
                group: emailItem.group?.name || null,
            }));

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.LIST_EMAILS,
                request.apiKey.id,
                undefined,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            return {
                success: true,
                data: {
                    total: emails.length,
                    emails: emails,
                },
            };
        } catch (err: unknown) {
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.LIST_EMAILS,
                request.apiKey?.id,
                undefined,
                request.ip,
                getErrorStatusCode(err),
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 邮箱池统计（支持分组过滤）
    // ========================================
    fastify.all('/pool-stats', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        try {
            if (!request.apiKey?.id) {
                throw new AppError('AUTH_REQUIRED', 'API Key required', 401);
            }
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.POOL_STATS);
            const groupName = getGroupNameFromRequest(request.method, request.query, request.body);
            const stats = await poolService.getStats(request.apiKey.id, groupName);

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.POOL_STATS,
                request.apiKey.id,
                undefined,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            return { success: true, data: stats };
        } catch (err: unknown) {
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.POOL_STATS,
                request.apiKey?.id,
                undefined,
                request.ip,
                getErrorStatusCode(err),
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 重置邮箱池（支持分组过滤）
    // ========================================
    fastify.all('/reset-pool', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        try {
            if (!request.apiKey?.id) {
                throw new AppError('AUTH_REQUIRED', 'API Key required', 401);
            }
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.POOL_RESET);
            const groupName = getGroupNameFromRequest(request.method, request.query, request.body);
            await poolService.reset(request.apiKey.id, groupName);

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.POOL_RESET,
                request.apiKey.id,
                undefined,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            return { success: true, data: { message: `Pool reset successfully${groupName ? ` for group '${groupName}'` : ''}` } };
        } catch (err: unknown) {
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.POOL_RESET,
                request.apiKey?.id,
                undefined,
                request.ip,
                getErrorStatusCode(err),
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 公共：按 Key 解析邮箱并校验访问范围
    // ========================================
    const resolveAccessibleEmail = async (apiKeyId: number, address: string) => {
        const emailAccount = await emailService.getByEmail(address);
        if (!emailAccount) {
            throw new AppError('EMAIL_NOT_FOUND', 'Email account not found', 404);
        }
        await poolService.assertEmailAccessible(apiKeyId, emailAccount.id, emailAccount.groupId ?? null);
        return emailAccount;
    };

    const requireApiKeyId = (apiKey: { id: number } | undefined): number => {
        if (!apiKey?.id) {
            throw new AppError('AUTH_REQUIRED', 'API Key required', 401);
        }
        return apiKey.id;
    };

    // ========================================
    // 领取邮箱（带租约，到期自动回收）
    // ========================================
    fastify.all('/claim-email', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        let emailAccountId: number | undefined;
        try {
            const apiKeyId = requireApiKeyId(request.apiKey);
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.CLAIM_EMAIL);
            const input = claimRequestSchema.parse(getRequestInput(request.method, request.query, request.body));

            const claim = await poolService.claimEmail(apiKeyId, input.group, input.lease);
            emailAccountId = claim.id;

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.CLAIM_EMAIL,
                apiKeyId,
                claim.id,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            return {
                success: true,
                data: {
                    email: claim.email,
                    id: claim.id,
                    status: 'CLAIMED',
                    claimedAt: claim.claimedAt,
                    leaseExpiresAt: claim.leaseExpiresAt,
                    leaseSeconds: input.lease,
                },
            };
        } catch (err: unknown) {
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.CLAIM_EMAIL,
                request.apiKey?.id,
                emailAccountId,
                request.ip,
                getErrorStatusCode(err),
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 完成领取（邮箱已用完，不再分配）
    // ========================================
    fastify.all('/complete-email', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        let emailAccountId: number | undefined;
        try {
            const apiKeyId = requireApiKeyId(request.apiKey);
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.COMPLETE_EMAIL);
            const input = claimTargetSchema.parse(getRequestInput(request.method, request.query, request.body));

            const emailAccount = await resolveAccessibleEmail(apiKeyId, input.email);
            emailAccountId = emailAccount.id;
            const result = await poolService.completeClaim(apiKeyId, emailAccount.id);

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.COMPLETE_EMAIL,
                apiKeyId,
                emailAccount.id,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            return {
                success: true,
                data: {
                    email: emailAccount.email,
                    status: result.status,
                    completedAt: result.completedAt,
                    alreadyCompleted: result.alreadyCompleted,
                },
            };
        } catch (err: unknown) {
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.COMPLETE_EMAIL,
                request.apiKey?.id,
                emailAccountId,
                request.ip,
                getErrorStatusCode(err),
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 释放领取（邮箱回到池中）
    // ========================================
    fastify.all('/release-email', apiRouteConfig, async (request) => {
        const startTime = Date.now();
        let emailAccountId: number | undefined;
        try {
            const apiKeyId = requireApiKeyId(request.apiKey);
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.RELEASE_EMAIL);
            const input = claimTargetSchema.parse(getRequestInput(request.method, request.query, request.body));

            const emailAccount = await resolveAccessibleEmail(apiKeyId, input.email);
            emailAccountId = emailAccount.id;
            await poolService.releaseClaim(apiKeyId, emailAccount.id);

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.RELEASE_EMAIL,
                apiKeyId,
                emailAccount.id,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            return {
                success: true,
                data: {
                    email: emailAccount.email,
                    released: true,
                },
            };
        } catch (err: unknown) {
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.RELEASE_EMAIL,
                request.apiKey?.id,
                emailAccountId,
                request.ip,
                getErrorStatusCode(err),
                Date.now() - startTime,
                request.id
            );
            throw err;
        }
    });

    // ========================================
    // 长轮询等待验证码
    // ========================================
    fastify.all('/wait_code', apiRouteConfig, async (request, reply) => {
        const startTime = Date.now();
        const rawInput = getRequestInput(request.method, request.query, request.body);
        const wantsText = typeof rawInput.format === 'string' && rawInput.format.toLowerCase() === 'text';
        let emailAccountId: number | undefined;
        let releaseSlot = () => {};

        // 客户端断开时停止轮询
        const abortController = new AbortController();
        const onClose = () => {
            if (!reply.raw.writableEnded) {
                abortController.abort();
            }
        };
        reply.raw.on('close', onClose);

        try {
            const apiKeyId = requireApiKeyId(request.apiKey);
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.WAIT_CODE);
            const input = waitCodeRequestSchema.parse(rawInput);

            let regex: RegExp | undefined;
            if (input.match) {
                if (!isSafeUserRegex(input.match)) {
                    throw new AppError('INVALID_REGEX', 'Regex pattern rejected (too long or potentially catastrophic)', 400);
                }
                try {
                    regex = new RegExp(input.match);
                } catch {
                    throw new AppError('INVALID_REGEX', 'Invalid regex pattern', 400);
                }
            }

            const emailAccount = await resolveAccessibleEmail(apiKeyId, input.email);
            emailAccountId = emailAccount.id;

            const explicitSince = parseSinceParam(input.since);
            if (explicitSince === null) {
                throw new AppError('INVALID_SINCE', 'Invalid since parameter (use ISO time or unix timestamp)', 400);
            }
            const since = explicitSince ?? resolveDefaultSince(
                new Date(startTime),
                (await poolService.getActiveUsage(apiKeyId, emailAccount.id))?.usedAt
            );

            const slot = acquireWaitSlot(apiKeyId);
            if (!slot) {
                throw new AppError('TOO_MANY_WAITS', 'Too many concurrent wait_code requests for this API Key', 429);
            }
            releaseSlot = slot;

            const credentials = {
                id: emailAccount.id,
                email: emailAccount.email,
                clientId: emailAccount.clientId,
                refreshToken: emailAccount.refreshToken!,
                autoAssigned: false,
                fetchStrategy: emailAccount.fetchStrategy,
            };

            let result: WaitCodeResult | null;
            try {
                result = await waitForVerificationCode(
                    (mailbox) => mailService.getEmails(credentials, {
                        mailbox,
                        limit: WAIT_CODE_FETCH_LIMIT,
                        socks5: input.socks5,
                        http: input.http,
                    }),
                    {
                        mailboxes: input.mailbox === 'all' ? ['inbox', 'junk'] : [input.mailbox],
                        since,
                        timeoutMs: input.timeout * 1000,
                        intervalMs: input.interval * 1000,
                        regex,
                        signal: abortController.signal,
                        onRetryError: (err, mailbox, attempt) => {
                            logger.warn({ err, email: credentials.email, mailbox, attempt }, 'wait_code fetch failed, retrying');
                        },
                    }
                );
            } catch (err: unknown) {
                await mailService.updateEmailStatus(emailAccount.id, false, getErrorMessage(err));
                throw err;
            }
            await mailService.updateEmailStatus(emailAccount.id, true);

            if (!result) {
                if (abortController.signal.aborted) {
                    // 客户端已断开，记录后结束
                    await mailService.logApiCall(
                        MAIL_LOG_ACTIONS.WAIT_CODE,
                        apiKeyId,
                        emailAccount.id,
                        request.ip,
                        499,
                        Date.now() - startTime,
                        request.id
                    );
                    return reply.code(499).send();
                }
                throw new AppError(
                    'CODE_TIMEOUT',
                    `No verification code received within ${input.timeout}s`,
                    404
                );
            }

            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.WAIT_CODE,
                apiKeyId,
                emailAccount.id,
                request.ip,
                200,
                Date.now() - startTime,
                request.id
            );

            if (wantsText) {
                return reply.type('text/plain').send(result.code);
            }

            return {
                success: true,
                data: {
                    email: emailAccount.email,
                    since: since.toISOString(),
                    ...result,
                },
            };
        } catch (err: unknown) {
            const statusCode = getErrorStatusCode(err);
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.WAIT_CODE,
                request.apiKey?.id,
                emailAccountId,
                request.ip,
                statusCode,
                Date.now() - startTime,
                request.id
            );
            if (wantsText) {
                return reply.code(statusCode).type('text/plain').send(`Error: ${getErrorMessage(err)}`);
            }
            throw err;
        } finally {
            releaseSlot();
            reply.raw.off('close', onClose);
        }
    });
};

export default mailRoutes;
