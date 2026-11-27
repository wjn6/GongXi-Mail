/**
 * 后台：发信记录与发信池统计
 */
import { type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../plugins/error.js';
import { EFFECTIVE_SEND_CAPABILITY_SQL } from './send.service.js';

const DB_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

const listSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED']).optional(),
    source: z.enum(['RESEND', 'ADMIN']).optional(),
    groupId: z.coerce.number().int().positive().optional(),
    apiKeyId: z.coerce.number().int().positive().optional(),
    emailAccountId: z.coerce.number().int().positive().optional(),
    keyword: z.string().trim().max(200).optional(),
});

interface GroupStatsRow {
    id: number;
    name: string;
    sendEnabled: boolean;
    sendTransport: string;
    sendStrategy: string;
    sendDailyLimit: number;
    sendIntervalSeconds: number;
    sendMaxRecipients: number;
    active: number;
    allowed: number;
    denied: number;
    unknown: number;
    cooling: number;
    remaining: number;
    sent24h: number;
}

const sendLogRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', fastify.authenticateJwt);

    // 发信池统计（按分组）
    fastify.get('/stats', async () => {
        const groups = await prisma.$queryRaw<GroupStatsRow[]>`
            SELECT g.id, g.name,
                   g.send_enabled AS "sendEnabled",
                   g.send_strategy::text AS "sendStrategy",
                   g.send_daily_limit AS "sendDailyLimit",
                   g.send_interval_seconds AS "sendIntervalSeconds",
                   g.send_max_recipients AS "sendMaxRecipients",
                   count(a.id) FILTER (WHERE a.status = 'ACTIVE')::int AS active,
                   g.send_transport::text AS "sendTransport",
                   count(a.id) FILTER (WHERE a.status = 'ACTIVE' AND ${EFFECTIVE_SEND_CAPABILITY_SQL} = 'ALLOWED')::int AS allowed,
                   count(a.id) FILTER (WHERE a.status = 'ACTIVE' AND ${EFFECTIVE_SEND_CAPABILITY_SQL} = 'DENIED')::int AS denied,
                   count(a.id) FILTER (WHERE a.status = 'ACTIVE' AND ${EFFECTIVE_SEND_CAPABILITY_SQL} = 'UNKNOWN')::int AS unknown,
                   count(a.id) FILTER (WHERE a.status = 'ACTIVE' AND a.send_cooldown_until > ${DB_NOW})::int AS cooling,
                   COALESCE(sum(GREATEST(g.send_daily_limit - COALESCE(s.sent, 0), 0))
                       FILTER (WHERE a.status = 'ACTIVE' AND ${EFFECTIVE_SEND_CAPABILITY_SQL} <> 'DENIED'), 0)::int AS remaining,
                   COALESCE(sum(s.sent), 0)::int AS "sent24h"
            FROM email_groups g
            LEFT JOIN email_accounts a ON a.group_id = g.id
            LEFT JOIN LATERAL (
                SELECT count(*)::int AS sent FROM send_logs l
                WHERE l.email_account_id = a.id
                  AND l.status IN ('SENT', 'SENDING')
                  AND l.attempted_at > ${DB_NOW} - interval '24 hours'
            ) s ON true
            GROUP BY g.id
            ORDER BY g.id ASC
        `;

        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [sent24h, failed24h, queued] = await Promise.all([
            prisma.sendLog.count({ where: { status: 'SENT', sentAt: { gte: since } } }),
            prisma.sendLog.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
            prisma.sendLog.count({ where: { status: { in: ['QUEUED', 'SENDING'] } } }),
        ]);

        return {
            success: true,
            data: {
                totals: { sent24h, failed24h, queued },
                groups,
            },
        };
    });

    // 发信记录列表
    fastify.get('/', async (request) => {
        const input = listSchema.parse(request.query);
        const where: Prisma.SendLogWhereInput = {};
        if (input.status) where.status = input.status;
        if (input.source) where.source = input.source;
        if (input.groupId) where.groupId = input.groupId;
        if (input.apiKeyId) where.apiKeyId = input.apiKeyId;
        if (input.emailAccountId) where.emailAccountId = input.emailAccountId;
        if (input.keyword) {
            where.OR = [
                { subject: { contains: input.keyword, mode: 'insensitive' } },
                { fromAddress: { contains: input.keyword, mode: 'insensitive' } },
                { requestedFrom: { contains: input.keyword, mode: 'insensitive' } },
            ];
        }

        const [list, total] = await Promise.all([
            prisma.sendLog.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (input.page - 1) * input.pageSize,
                take: input.pageSize,
                select: {
                    id: true,
                    source: true,
                    status: true,
                    requestedFrom: true,
                    fromName: true,
                    fromAddress: true,
                    toAddresses: true,
                    subject: true,
                    recipientCount: true,
                    attachmentCount: true,
                    attempts: true,
                    transport: true,
                    errorCode: true,
                    errorMessage: true,
                    batchId: true,
                    createdAt: true,
                    sentAt: true,
                    nextAttemptAt: true,
                    apiKey: { select: { id: true, name: true } },
                    group: { select: { id: true, name: true } },
                    emailAccount: { select: { id: true, email: true } },
                },
            }),
            prisma.sendLog.count({ where }),
        ]);

        return { success: true, data: { list, total, page: input.page, pageSize: input.pageSize } };
    });

    // 发信记录详情
    fastify.get('/:id', async (request) => {
        const { id } = request.params as { id: string };
        if (!/^[0-9a-f-]{36}$/i.test(id)) {
            throw new AppError('NOT_FOUND', 'Send log not found', 404);
        }
        const log = await prisma.sendLog.findUnique({
            where: { id },
            include: {
                apiKey: { select: { id: true, name: true } },
                group: { select: { id: true, name: true } },
                emailAccount: { select: { id: true, email: true } },
            },
        });
        if (!log) {
            throw new AppError('NOT_FOUND', 'Send log not found', 404);
        }
        return { success: true, data: log };
    });
};

export default sendLogRoutes;
