import { type FastifyPluginAsync } from 'fastify';
import { mailService } from './mail.service.js';
import { poolService } from './pool.service.js';
import { emailService } from '../email/email.service.js';
import { MAIL_LOG_ACTIONS } from './mail.actions.js';
import { z } from 'zod';
import { AppError } from '../../plugins/error.js';

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
    match: z.string().optional(), // 正则表达式 (可选)
});

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
    fastify.all('/get-email', async (request) => {
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
                        Date.now() - startTime
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
                Date.now() - startTime
            );
            throw err;
        }
    });

    // ========================================
    // 获取最新邮件（必须指定 email）
    // ========================================
    fastify.all('/mail_new', async (request) => {
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

        const credentials = {
            id: emailAccount.id,
            email: emailAccount.email,
            clientId: emailAccount.clientId,
            refreshToken: emailAccount.refreshToken!,
            autoAssigned: false,
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
                Date.now() - startTime
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
                Date.now() - startTime
            );
            throw err;
        }
    });

    // ========================================
    // 新增：获取最新邮件的纯文本内容 (脚本友好)
    // ========================================
    fastify.all('/mail_text', async (request, reply) => {
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
                Date.now() - startTime
            );
            reply.code(statusCode).type('text/plain').send(`Error: ${message}`);
            return;
        }

        const emailAccount = await emailService.getByEmail(input.email);
        if (!emailAccount) {
            reply.code(404).type('text/plain').send('Error: Email account not found');
            return;
        }

        const credentials = {
            id: emailAccount.id,
            email: emailAccount.email,
            clientId: emailAccount.clientId,
            refreshToken: emailAccount.refreshToken!,
            autoAssigned: false,
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
                Date.now() - startTime
            );

            if (!result.messages || result.messages.length === 0) {
                reply.type('text/plain').send('Error: No messages found');
                return;
            }

            const message = result.messages[0];
            // 优先使用 text 字段
            let content = message.text || '';

            // 如果指定了正则匹配
            if (input.match) {
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
                Date.now() - startTime
            );
            reply.code(500).type('text/plain').send(`Error: ${getErrorMessage(err)}`);
        }
    });

    // ========================================
    // 获取所有邮件（必须指定 email）
    // ========================================
    fastify.all('/mail_all', async (request) => {
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

        const credentials = {
            id: emailAccount.id,
            email: emailAccount.email,
            clientId: emailAccount.clientId,
            refreshToken: emailAccount.refreshToken!,
            autoAssigned: false,
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
                Date.now() - startTime
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
                Date.now() - startTime
            );
            throw err;
        }
    });

    // ========================================
    // 清空邮箱（必须指定 email）
    // ========================================
    fastify.all('/process-mailbox', async (request) => {
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

        const credentials = {
            id: emailAccount.id,
            email: emailAccount.email,
            clientId: emailAccount.clientId,
            refreshToken: emailAccount.refreshToken!,
            autoAssigned: false,
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
                Date.now() - startTime
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
                Date.now() - startTime
            );
            throw err;
        }
    });

    // ========================================
    // 列出系统 ACTIVE 邮箱（支持分组过滤）
    // ========================================
    fastify.all('/list-emails', async (request) => {
        const startTime = Date.now();
        try {
            if (!request.apiKey?.id) {
                throw new AppError('AUTH_REQUIRED', 'API Key required', 401);
            }
            fastify.assertApiPermission(request, MAIL_LOG_ACTIONS.LIST_EMAILS);

            const groupName = getGroupNameFromRequest(request.method, request.query, request.body);

            const result = await emailService.list({ page: 1, pageSize: 1000, status: 'ACTIVE', groupName });
            const emails = result.list.map((emailItem: { email: string; status: string; group?: { name: string } | null }) => ({
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
                Date.now() - startTime
            );

            return {
                success: true,
                data: {
                    total: result.total,
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
                Date.now() - startTime
            );
            throw err;
        }
    });

    // ========================================
    // 邮箱池统计（支持分组过滤）
    // ========================================
    fastify.all('/pool-stats', async (request) => {
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
                Date.now() - startTime
            );

            return { success: true, data: stats };
        } catch (err: unknown) {
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.POOL_STATS,
                request.apiKey?.id,
                undefined,
                request.ip,
                getErrorStatusCode(err),
                Date.now() - startTime
            );
            throw err;
        }
    });

    // ========================================
    // 重置邮箱池（支持分组过滤）
    // ========================================
    fastify.all('/reset-pool', async (request) => {
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
                Date.now() - startTime
            );

            return { success: true, data: { message: `Pool reset successfully${groupName ? ` for group '${groupName}'` : ''}` } };
        } catch (err: unknown) {
            await mailService.logApiCall(
                MAIL_LOG_ACTIONS.POOL_RESET,
                request.apiKey?.id,
                undefined,
                request.ip,
                getErrorStatusCode(err),
                Date.now() - startTime
            );
            throw err;
        }
    });
};

export default mailRoutes;
