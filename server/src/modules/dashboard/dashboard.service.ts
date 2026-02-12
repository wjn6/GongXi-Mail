import prisma from '../../lib/prisma.js';
import type { Prisma } from '@prisma/client';

function extractRequestIdFromMetadata(metadata: Prisma.JsonValue | null): string | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return null;
    }
    const requestId = (metadata as Record<string, unknown>).requestId;
    return typeof requestId === 'string' && requestId.trim() ? requestId : null;
}

export const dashboardService = {
    /**
     * 获取统计数据
     */
    async getStats() {
        const [
            totalEmails,
            activeEmails,
            errorEmails,
            totalApiKeys,
            activeApiKeys,
            totalUsage,
            todayActiveKeys,
        ] = await Promise.all([
            prisma.emailAccount.count(),
            prisma.emailAccount.count({ where: { status: 'ACTIVE' } }),
            prisma.emailAccount.count({ where: { status: 'ERROR' } }),
            prisma.apiKey.count(),
            prisma.apiKey.count({ where: { status: 'ACTIVE' } }),
            prisma.apiKey.aggregate({ _sum: { usageCount: true } }),
            prisma.apiKey.count({
                where: {
                    lastUsedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
                },
            }),
        ]);

        return {
            emails: {
                total: totalEmails,
                active: activeEmails,
                error: errorEmails,
            },
            apiKeys: {
                total: totalApiKeys,
                active: activeApiKeys,
                totalUsage: Number(totalUsage._sum.usageCount || 0),
                todayActive: todayActiveKeys,
            },
        };
    },

    /**
     * 获取 API 调用趋势
     */
    async getApiTrend(days: number = 7) {
        const safeDays = Math.max(1, Math.min(days, 90));
        const endDate = new Date();
        endDate.setHours(0, 0, 0, 0);
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - safeDays + 1);
        const nextDate = new Date(endDate);
        nextDate.setDate(nextDate.getDate() + 1);

        const rows = await prisma.$queryRaw<Array<{ date: string; count: bigint | number }>>`
            WITH day_series AS (
                SELECT generate_series(${startDate}::date, ${endDate}::date, interval '1 day')::date AS day
            ),
            day_counts AS (
                SELECT
                    date_trunc('day', "created_at")::date AS day,
                    COUNT(*)::bigint AS count
                FROM "api_logs"
                WHERE "created_at" >= ${startDate}
                  AND "created_at" < ${nextDate}
                GROUP BY 1
            )
            SELECT
                to_char(day_series.day, 'YYYY-MM-DD') AS date,
                COALESCE(day_counts.count, 0)::bigint AS count
            FROM day_series
            LEFT JOIN day_counts ON day_counts.day = day_series.day
            ORDER BY day_series.day ASC
        `;

        return rows.map((row) => ({
            date: row.date,
            count: Number(row.count),
        }));
    },

    /**
     * 获取操作日志
     */
    async getLogs(options: { page?: number; pageSize?: number; action?: string }) {
        const { page = 1, pageSize = 20, action } = options;
        const skip = (page - 1) * pageSize;

        const where: Prisma.ApiLogWhereInput = {};
        if (action) where.action = action;

        const [list, total] = await Promise.all([
            prisma.apiLog.findMany({
                where,
                select: {
                    id: true,
                    action: true,
                    requestIp: true,
                    responseCode: true,
                    responseTimeMs: true,
                    metadata: true,
                    createdAt: true,
                    apiKey: { select: { name: true } },
                    emailAccount: { select: { email: true } },
                },
                skip,
                take: pageSize,
                orderBy: { createdAt: 'desc' },
            }),
            prisma.apiLog.count({ where }),
        ]);

        const formattedList = list.map(log => ({
            id: Number(log.id),
            action: log.action,
            apiKeyName: log.apiKey?.name || '-',
            email: log.emailAccount?.email || '-',
            requestIp: log.requestIp,
            responseCode: log.responseCode,
            responseTimeMs: log.responseTimeMs,
            requestId: extractRequestIdFromMetadata(log.metadata),
            createdAt: log.createdAt,
        }));

        return { list: formattedList, total, page, pageSize };
    },
};
