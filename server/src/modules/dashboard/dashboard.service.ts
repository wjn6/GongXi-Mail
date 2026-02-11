import prisma from '../../lib/prisma.js';
import type { Prisma } from '@prisma/client';

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
        const result: { date: string; count: number }[] = [];
        const today = new Date();

        for (let i = days - 1; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];

            const startOfDay = new Date(dateStr);
            const endOfDay = new Date(dateStr);
            endOfDay.setDate(endOfDay.getDate() + 1);

            const count = await prisma.apiLog.count({
                where: {
                    createdAt: {
                        gte: startOfDay,
                        lt: endOfDay,
                    },
                },
            });

            result.push({ date: dateStr, count });
        }

        return result;
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
            createdAt: log.createdAt,
        }));

        return { list: formattedList, total, page, pageSize };
    },
};
