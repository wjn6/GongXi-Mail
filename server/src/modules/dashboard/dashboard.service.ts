import prisma from '../../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { buildApiTrend, getUtcTrendRange } from './dashboard.trend.js';

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
        const { startDate, nextDate, dateKeys } = getUtcTrendRange(days);
        const logs = await prisma.apiLog.findMany({
            where: {
                createdAt: {
                    gte: startDate,
                    lt: nextDate,
                },
            },
            select: {
                createdAt: true,
            },
        });

        return buildApiTrend(
            logs.map(log => log.createdAt),
            dateKeys
        );
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
