/**
 * Resend 兼容接口（挂载在 /resend 下）：
 *   POST /resend/emails          发送邮件
 *   POST /resend/emails/batch    批量发送（最多 100 封，排队发送，不支持附件）
 *   GET  /resend/emails/:id      查询已发邮件
 *   GET  /resend/emails          列出已发邮件（游标分页）
 * 请求字段、响应结构与错误格式与 Resend 保持一致；实际由分组的 Graph 账号池发出。
 */
import { randomUUID } from 'node:crypto';
import { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../plugins/error.js';
import { MAIL_LOG_ACTIONS } from '../mail/mail.actions.js';
import { mailService } from '../mail/mail.service.js';
import { poolService } from '../mail/pool.service.js';
import {
    SEND_ATTACHMENT_MAX_BYTES,
    SendRequestError,
    computeRequestHash,
    normalizeSendRequest,
    type NormalizedSendRequest,
    type SendAttachmentInput,
} from '../../lib/send-mail.js';
import {
    RESEND_BATCH_MAX,
    ResendApiError,
    isUuid,
    parseBatchValidationMode,
    parseListQuery,
    parseResendEmailPayload,
    toResendEmailObject,
    toResendError,
    toResendListItem,
    validateIdempotencyKey,
    type ParsedResendEmail,
} from '../../lib/resend-compat.js';
import { downloadRemoteAttachment } from '../../lib/remote-attachment.js';
import {
    getPoolCapacity,
    resolvePreferredSender,
    sendFromPool,
    type SendOutcome,
    type SendScope,
} from '../send/send.service.js';
import {
    beginIdempotentRequest,
    completeIdempotentRequest,
    releaseIdempotentRequest,
} from '../send/idempotency.service.js';
import { kickSendQueue } from '../../jobs/send-queue.js';

/** /resend 路由自带按 Key 限流，关闭全局 IP 限流 */
const routeConfig = { rateLimit: false } as const;
/** 单封邮件请求体上限：3 MB 附件 base64 后约 4 MB，再加正文 */
const SINGLE_BODY_LIMIT = 8 * 1024 * 1024;
const BATCH_BODY_LIMIT = 10 * 1024 * 1024;

function mapAuthError(err: unknown): unknown {
    if (!(err instanceof AppError)) return err;
    switch (err.code) {
        case 'UNAUTHORIZED':
            return new ResendApiError(401, 'missing_api_key', 'Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY.');
        case 'INVALID_API_KEY':
            return new ResendApiError(401, 'validation_error', 'API key is invalid');
        case 'API_KEY_DISABLED':
        case 'API_KEY_EXPIRED':
            return new ResendApiError(403, 'restricted_api_key', 'API key is not active');
        case 'RATE_LIMIT_EXCEEDED':
            return new ResendApiError(429, 'rate_limit_exceeded', err.message);
        default:
            return err;
    }
}

function assertPermission(request: FastifyRequest, action: string, message: string) {
    try {
        request.server.assertApiPermission(request, action);
    } catch (err) {
        if (err instanceof AppError && err.code === 'FORBIDDEN_PERMISSION') {
            throw new ResendApiError(401, 'restricted_api_key', message);
        }
        throw err;
    }
}

function requireApiKeyId(request: FastifyRequest): number {
    if (!request.apiKey?.id) {
        throw new ResendApiError(401, 'missing_api_key', 'Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY.');
    }
    return request.apiKey.id;
}

function outcomeToError(outcome: Extract<SendOutcome, { ok: false }>): ResendApiError {
    switch (outcome.reason) {
        case 'NO_POOL':
        case 'FROM_NOT_IN_POOL':
        case 'NO_PERMISSION':
            return new ResendApiError(403, 'validation_error', outcome.message);
        case 'TOO_MANY_RECIPIENTS':
            return new ResendApiError(422, 'validation_error', outcome.message);
        case 'DAILY_QUOTA':
            return new ResendApiError(429, 'daily_quota_exceeded', outcome.message);
        case 'RATE_LIMITED':
            return new ResendApiError(429, 'rate_limit_exceeded', outcome.message);
        case 'THROTTLED':
        case 'BLOCKED':
            return new ResendApiError(429, 'rate_limit_exceeded', `Microsoft Graph throttled the sending accounts: ${outcome.message}`);
        case 'REQUEST':
            return new ResendApiError(422, 'validation_error', `Microsoft Graph rejected the email: ${outcome.message}`);
        default:
            return new ResendApiError(500, 'application_error', `Failed to send the email: ${outcome.message}`);
    }
}

function estimateBase64Bytes(content: string): number {
    const clean = content.replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** 下载 path 附件并转为 base64 content（总大小受 Graph 单次请求上限约束） */
async function resolveAttachments(attachments: SendAttachmentInput[] | undefined): Promise<SendAttachmentInput[] | undefined> {
    if (!attachments || attachments.length === 0) return attachments;
    let used = attachments.reduce((sum, item) => sum + (item.content ? estimateBase64Bytes(item.content) : 0), 0);
    const result: SendAttachmentInput[] = [];
    for (const [index, item] of attachments.entries()) {
        if (item.content || !item.path) {
            result.push(item);
            continue;
        }
        const remaining = SEND_ATTACHMENT_MAX_BYTES - used;
        if (remaining <= 0) {
            throw new ResendApiError(422, 'invalid_attachment', `Attachments exceed ${SEND_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB in total (limit of a single Microsoft Graph sendMail request).`);
        }
        const downloaded = await downloadRemoteAttachment(item.path, index, remaining);
        used += downloaded.size;
        result.push({
            filename: item.filename || downloaded.filename,
            content: downloaded.contentBase64,
            contentType: item.contentType || downloaded.contentType,
            contentId: item.contentId,
        });
    }
    return result;
}

function normalizeParsed(parsed: ParsedResendEmail): NormalizedSendRequest {
    try {
        return normalizeSendRequest(parsed.sendInput);
    } catch (err) {
        if (err instanceof SendRequestError) throw toResendError(err);
        throw err;
    }
}

function logData(
    id: string,
    parsed: ParsedResendEmail,
    request: NormalizedSendRequest,
    context: { apiKeyId: number; requestIp: string; batchId?: string; batchIndex?: number }
): Prisma.SendLogCreateManyInput {
    return {
        id,
        source: 'RESEND',
        status: 'QUEUED',
        apiKeyId: context.apiKeyId,
        requestedFrom: parsed.requestedFrom,
        fromName: request.fromName ?? null,
        toAddresses: request.to as unknown as Prisma.InputJsonValue,
        ccAddresses: request.cc.length > 0 ? request.cc as unknown as Prisma.InputJsonValue : undefined,
        bccAddresses: request.bcc.length > 0 ? request.bcc as unknown as Prisma.InputJsonValue : undefined,
        replyTo: request.replyTo.length > 0 ? request.replyTo as unknown as Prisma.InputJsonValue : undefined,
        subject: request.subject,
        html: request.html,
        text: request.text,
        headers: request.headers.length > 0 ? request.headers as unknown as Prisma.InputJsonValue : undefined,
        tags: parsed.tags.length > 0 ? parsed.tags as unknown as Prisma.InputJsonValue : undefined,
        recipientCount: request.recipientCount,
        attachmentCount: request.attachments.length,
        attachmentBytes: request.attachmentBytes,
        batchId: context.batchId,
        batchIndex: context.batchIndex,
        requestIp: context.requestIp,
        nextAttemptAt: context.batchId ? new Date() : undefined,
    };
}

async function logCall(request: FastifyRequest, action: string, statusCode: number, startTime: number, emailAccountId?: number) {
    await mailService.logApiCall(
        action,
        request.apiKey?.id,
        emailAccountId,
        request.ip,
        statusCode,
        Date.now() - startTime,
        request.id
    );
}

function statusOf(err: unknown): number {
    if (err instanceof ResendApiError) return err.statusCode;
    if (err instanceof AppError) return err.statusCode;
    return 500;
}

const resendRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', async (request, reply) => {
        try {
            await fastify.authenticateApiKey(request, reply);
        } catch (err) {
            // 带了 Authorization 头但不是本系统的 sk_ Key：与 Resend 一致按无效 Key 处理
            if (err instanceof AppError && err.code === 'UNAUTHORIZED' && request.headers.authorization) {
                throw new ResendApiError(401, 'validation_error', 'API key is invalid');
            }
            throw mapAuthError(err);
        }
    });

    fastify.setErrorHandler((error, request, reply: FastifyReply) => {
        let resendError: ResendApiError;
        if (error instanceof ResendApiError) {
            resendError = error;
        } else if (error instanceof SendRequestError) {
            resendError = toResendError(error);
        } else if (error instanceof ZodError) {
            resendError = new ResendApiError(422, 'validation_error', error.errors[0]?.message || 'Invalid request.');
        } else if (error instanceof AppError) {
            const mapped = mapAuthError(error);
            resendError = mapped instanceof ResendApiError
                ? mapped
                : new ResendApiError(error.statusCode, error.statusCode >= 500 ? 'application_error' : 'validation_error', error.message);
        } else {
            const fastifyError = error as { code?: string; statusCode?: number; message?: string };
            if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
                resendError = new ResendApiError(422, 'validation_error', 'Request body is too large.');
            } else if (fastifyError.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
                resendError = new ResendApiError(422, 'validation_error', 'Invalid content type. Use `Content-Type: application/json`.');
            } else if (fastifyError.statusCode === 400 && fastifyError.code?.startsWith('FST_ERR_CTP')) {
                resendError = new ResendApiError(422, 'validation_error', 'Invalid JSON body.');
            } else if (fastifyError.statusCode && fastifyError.statusCode < 500) {
                resendError = new ResendApiError(fastifyError.statusCode, 'validation_error', fastifyError.message || 'Invalid request.');
            } else {
                request.log.error({ err: error }, 'Resend compatible API error');
                resendError = new ResendApiError(500, 'internal_server_error', 'An unexpected error occurred.');
            }
        }
        if (resendError.statusCode >= 500) {
            request.log.error({ err: error, requestId: request.id }, 'Resend compatible API failed');
        }
        return reply.status(resendError.statusCode).send(resendError.toBody());
    });

    fastify.setNotFoundHandler((_request, reply) => {
        return reply.status(404).send(new ResendApiError(404, 'not_found', 'The requested endpoint does not exist.').toBody());
    });

    const methodNotAllowed = async () => {
        throw new ResendApiError(405, 'method_not_allowed', 'Method is not allowed for the requested path.');
    };
    fastify.route({ method: ['PUT', 'PATCH', 'DELETE'], url: '/emails', config: routeConfig, handler: methodNotAllowed });
    fastify.route({ method: ['GET', 'PUT', 'PATCH', 'DELETE'], url: '/emails/batch', config: routeConfig, handler: methodNotAllowed });
    fastify.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE'], url: '/emails/:id', config: routeConfig, handler: methodNotAllowed });

    // ========================================
    // 发送邮件
    // ========================================
    fastify.post('/emails', { config: routeConfig, bodyLimit: SINGLE_BODY_LIMIT }, async (request, reply) => {
        const startTime = Date.now();
        let idempotencyRecordId: number | undefined;
        let accountId: number | undefined;
        try {
            const apiKeyId = requireApiKeyId(request);
            assertPermission(request, MAIL_LOG_ACTIONS.SEND_MAIL, 'This API key is not allowed to send emails. Enable the `send_mail` permission in the admin console.');
            const idempotencyKey = validateIdempotencyKey(request.headers['idempotency-key']);

            const parsed = parseResendEmailPayload(request.body, { batch: false });

            if (idempotencyKey) {
                const begin = await beginIdempotentRequest(apiKeyId, 'emails', idempotencyKey, computeRequestHash(request.body));
                if (begin.kind === 'replay') {
                    await logCall(request, MAIL_LOG_ACTIONS.SEND_MAIL, begin.status, startTime);
                    return reply.status(begin.status).send(begin.body);
                }
                idempotencyRecordId = begin.recordId;
            }

            parsed.sendInput.attachments = await resolveAttachments(parsed.sendInput.attachments);
            const normalized = normalizeParsed(parsed);
            const scope: SendScope = await poolService.getApiKeyScope(apiKeyId);
            const preferredAddress = await resolvePreferredSender(parsed.from.address, scope);

            const id = randomUUID();
            await prisma.sendLog.create({
                data: logData(id, parsed, normalized, { apiKeyId, requestIp: request.ip }) as Prisma.SendLogUncheckedCreateInput,
            });

            const outcome = await sendFromPool(id, normalized, { scope, preferredAddress });
            if (!outcome.ok) {
                if (outcome.noAttempt) {
                    // 没有分配到账号，不留下查询得到的记录
                    await prisma.sendLog.deleteMany({ where: { id } });
                }
                throw outcomeToError(outcome);
            }

            accountId = outcome.accountId;
            const body = { id };
            if (idempotencyRecordId) {
                await completeIdempotentRequest(idempotencyRecordId, 200, body);
            }
            await logCall(request, MAIL_LOG_ACTIONS.SEND_MAIL, 200, startTime, accountId);
            return body;
        } catch (err) {
            if (idempotencyRecordId) {
                await releaseIdempotentRequest(idempotencyRecordId).catch(() => undefined);
            }
            await logCall(request, MAIL_LOG_ACTIONS.SEND_MAIL, statusOf(err), startTime, accountId);
            throw err;
        }
    });

    // ========================================
    // 批量发送（排队）
    // ========================================
    fastify.post('/emails/batch', { config: routeConfig, bodyLimit: BATCH_BODY_LIMIT }, async (request, reply) => {
        const startTime = Date.now();
        let idempotencyRecordId: number | undefined;
        try {
            const apiKeyId = requireApiKeyId(request);
            assertPermission(request, MAIL_LOG_ACTIONS.SEND_MAIL, 'This API key is not allowed to send emails. Enable the `send_mail` permission in the admin console.');
            const idempotencyKey = validateIdempotencyKey(request.headers['idempotency-key']);
            const mode = parseBatchValidationMode(request.headers['x-batch-validation']);

            const payload = request.body;
            if (!Array.isArray(payload)) {
                throw new ResendApiError(422, 'validation_error', 'Invalid request body. Expected an array of emails.');
            }
            if (payload.length === 0) {
                throw new ResendApiError(422, 'validation_error', 'The batch must contain at least one email.');
            }
            if (payload.length > RESEND_BATCH_MAX) {
                throw new ResendApiError(422, 'validation_error', `The batch can contain at most ${RESEND_BATCH_MAX} emails.`);
            }

            const scope: SendScope = await poolService.getApiKeyScope(apiKeyId);
            const capacity = await getPoolCapacity(scope);
            if (capacity.senders === 0) {
                throw new ResendApiError(403, 'validation_error', 'No sending accounts are available for this API key. Enable sending on an email group in the admin console, and make sure the group is within the API key scope.');
            }

            const valid: Array<{ index: number; parsed: ParsedResendEmail; normalized: NormalizedSendRequest }> = [];
            const errors: Array<{ index: number; message: string }> = [];
            payload.forEach((item, index) => {
                try {
                    const parsed = parseResendEmailPayload(item, { batch: true });
                    const normalized = normalizeParsed(parsed);
                    if (normalized.recipientCount > capacity.maxRecipients) {
                        throw new ResendApiError(422, 'validation_error', `Too many recipients. The sending group allows at most ${capacity.maxRecipients} recipients (to + cc + bcc) per email.`);
                    }
                    valid.push({ index, parsed, normalized });
                } catch (err) {
                    const message = err instanceof Error ? err.message : 'Invalid email.';
                    errors.push({ index, message });
                }
            });

            if (mode === 'strict' && errors.length > 0) {
                throw new ResendApiError(422, 'validation_error', `Invalid email at index ${errors[0].index}: ${errors[0].message}`);
            }

            if (idempotencyKey) {
                const begin = await beginIdempotentRequest(
                    apiKeyId,
                    'emails/batch',
                    idempotencyKey,
                    computeRequestHash({ mode, payload })
                );
                if (begin.kind === 'replay') {
                    await logCall(request, MAIL_LOG_ACTIONS.SEND_MAIL, begin.status, startTime);
                    return reply.status(begin.status).send(begin.body);
                }
                idempotencyRecordId = begin.recordId;
            }

            const batchId = randomUUID();
            const rows = valid.map(({ index, parsed, normalized }) => logData(randomUUID(), parsed, normalized, {
                apiKeyId,
                requestIp: request.ip,
                batchId,
                batchIndex: index,
            }));
            if (rows.length > 0) {
                await prisma.sendLog.createMany({ data: rows });
                kickSendQueue();
            }

            const body = mode === 'permissive'
                ? { data: rows.map((row) => ({ id: row.id })), errors }
                : { data: rows.map((row) => ({ id: row.id })) };
            if (idempotencyRecordId) {
                await completeIdempotentRequest(idempotencyRecordId, 200, body);
            }
            await logCall(request, MAIL_LOG_ACTIONS.SEND_MAIL, 200, startTime);
            return body;
        } catch (err) {
            if (idempotencyRecordId) {
                await releaseIdempotentRequest(idempotencyRecordId).catch(() => undefined);
            }
            await logCall(request, MAIL_LOG_ACTIONS.SEND_MAIL, statusOf(err), startTime);
            throw err;
        }
    });

    // ========================================
    // 查询已发邮件
    // ========================================
    fastify.get('/emails/:id', { config: routeConfig }, async (request) => {
        const startTime = Date.now();
        try {
            const apiKeyId = requireApiKeyId(request);
            assertPermission(request, MAIL_LOG_ACTIONS.SEND_READ, 'This API key is restricted to only send emails. Enable the `send_read` permission to retrieve sent emails.');
            const { id } = request.params as { id: string };
            if (!isUuid(id)) {
                throw new ResendApiError(422, 'invalid_parameter', 'The `id` must be a valid UUID.');
            }
            const row = await prisma.sendLog.findFirst({ where: { id, apiKeyId, source: 'RESEND' } });
            if (!row) {
                throw new ResendApiError(404, 'not_found', 'Email not found');
            }
            await logCall(request, MAIL_LOG_ACTIONS.SEND_READ, 200, startTime, row.emailAccountId ?? undefined);
            return toResendEmailObject(row);
        } catch (err) {
            await logCall(request, MAIL_LOG_ACTIONS.SEND_READ, statusOf(err), startTime);
            throw err;
        }
    });

    // ========================================
    // 列出已发邮件（按创建时间倒序，after / before 游标）
    // ========================================
    fastify.get('/emails', { config: routeConfig }, async (request) => {
        const startTime = Date.now();
        try {
            const apiKeyId = requireApiKeyId(request);
            assertPermission(request, MAIL_LOG_ACTIONS.SEND_READ, 'This API key is restricted to only send emails. Enable the `send_read` permission to list sent emails.');
            const query = parseListQuery(request.query);

            const baseWhere: Prisma.SendLogWhereInput = { apiKeyId, source: 'RESEND' };
            let cursorWhere: Prisma.SendLogWhereInput | undefined;
            const cursorId = query.after ?? query.before;
            if (cursorId) {
                const cursor = await prisma.sendLog.findFirst({
                    where: { ...baseWhere, id: cursorId },
                    select: { id: true, createdAt: true },
                });
                if (!cursor) {
                    throw new ResendApiError(422, 'invalid_parameter', `The \`${query.after ? 'after' : 'before'}\` cursor does not match any email.`);
                }
                cursorWhere = query.after
                    ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
                    : { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] };
            }

            const ascending = !!query.before;
            const rows = await prisma.sendLog.findMany({
                where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
                orderBy: ascending
                    ? [{ createdAt: 'asc' }, { id: 'asc' }]
                    : [{ createdAt: 'desc' }, { id: 'desc' }],
                take: query.limit + 1,
            });
            const hasMore = rows.length > query.limit;
            const page = rows.slice(0, query.limit);
            if (ascending) page.reverse();

            await logCall(request, MAIL_LOG_ACTIONS.SEND_READ, 200, startTime);
            return {
                object: 'list',
                has_more: hasMore,
                data: page.map((row) => toResendListItem(row)),
            };
        } catch (err) {
            await logCall(request, MAIL_LOG_ACTIONS.SEND_READ, statusOf(err), startTime);
            throw err;
        }
    });
};

export default resendRoutes;
