import prisma from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import { AppError } from '../../plugins/error.js';
import type { Prisma } from '@prisma/client';

function hasErrorCode(error: unknown, code: string): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    return (error as { code?: unknown }).code === code;
}

/**
 * 根据分组名解析 groupId，返回 undefined 表示不过滤
 */
async function resolveGroupId(groupName?: string): Promise<number | undefined> {
    if (!groupName) return undefined;
    const group = await prisma.emailGroup.findUnique({ where: { name: groupName } });
    if (!group) {
        throw new AppError('GROUP_NOT_FOUND', `Email group '${groupName}' not found`, 404);
    }
    return group.id;
}

export const poolService = {
    /**
     * 获取未被该 API Key 使用过的邮箱（可按分组过滤）
     */
    async getUnusedEmail(apiKeyId: number, groupName?: string) {
        const groupId = await resolveGroupId(groupName);

        const where: Prisma.EmailAccountWhereInput = {
            status: 'ACTIVE',
            NOT: {
                usages: {
                    some: { apiKeyId },
                },
            },
        };
        if (groupId !== undefined) {
            where.groupId = groupId;
        }

        const email = await prisma.emailAccount.findFirst({
            where,
            select: {
                id: true,
                email: true,
                clientId: true,
                refreshToken: true,
            },
            orderBy: { id: 'asc' },
        });

        if (!email) {
            return null;
        }

        return {
            ...email,
            refreshToken: decrypt(email.refreshToken),
        };
    },

    /**
     * 标记邮箱已被使用
     */
    async markUsed(apiKeyId: number, emailAccountId: number) {
        try {
            await prisma.emailUsage.create({
                data: { apiKeyId, emailAccountId, usedAt: new Date() },
            });
        } catch (error: unknown) {
            if (hasErrorCode(error, 'P2002')) {
                throw new AppError('ALREADY_USED', 'Email already allocated to this API Key', 409);
            }
            throw error;
        }
    },

    /**
     * 检查 API Key 是否拥有该邮箱的使用权
     */
    async checkOwnership(apiKeyId: number, emailAddress: string) {
        const email = await prisma.emailAccount.findUnique({
            where: { email: emailAddress },
            include: {
                usages: {
                    where: { apiKeyId },
                },
            },
        });

        if (!email) {
            throw new AppError('EMAIL_NOT_FOUND', 'Email account not found', 404);
        }

        return email.usages.length > 0;
    },

    /**
     * 获取已分配给该 API Key 的邮箱列表
     */
    async getAllocatedEmails(apiKeyId: number) {
        const usages = await prisma.emailUsage.findMany({
            where: { apiKeyId },
            include: {
                emailAccount: {
                    select: {
                        id: true,
                        email: true,
                        status: true,
                    },
                },
            },
        });

        return usages.map((u: { emailAccount: { email: string; status: string }; usedAt: Date }) => ({
            email: u.emailAccount.email,
            status: u.emailAccount.status,
            allocatedAt: u.usedAt,
        }));
    },

    /**
     * 获取使用统计（可按分组过滤）
     */
    async getStats(apiKeyId: number, groupName?: string) {
        const groupId = await resolveGroupId(groupName);

        const emailWhere: Prisma.EmailAccountWhereInput = { status: 'ACTIVE' };
        if (groupId !== undefined) {
            emailWhere.groupId = groupId;
        }

        // 获取该分组中的邮箱 ID 集合
        const emailIds = groupId !== undefined
            ? (await prisma.emailAccount.findMany({
                where: emailWhere,
                select: { id: true },
            })).map((e: { id: number }) => e.id)
            : undefined;

        const usageWhere: Prisma.EmailUsageWhereInput = { apiKeyId };
        if (emailIds) {
            usageWhere.emailAccountId = { in: emailIds };
        }

        const [total, used] = await Promise.all([
            prisma.emailAccount.count({ where: emailWhere }),
            prisma.emailUsage.count({ where: usageWhere }),
        ]);

        return { total, used, remaining: Math.max(0, total - used) };
    },

    /**
     * 重置使用记录（可按分组过滤）
     */
    async reset(apiKeyId: number, groupName?: string) {
        const groupId = await resolveGroupId(groupName);

        if (groupId !== undefined) {
            // 仅重置该分组的邮箱使用记录
            const emailIds = (await prisma.emailAccount.findMany({
                where: { groupId, status: 'ACTIVE' },
                select: { id: true },
            })).map((e: { id: number }) => e.id);

            if (emailIds.length > 0) {
                await prisma.emailUsage.deleteMany({
                    where: {
                        apiKeyId,
                        emailAccountId: { in: emailIds },
                    },
                });
            }
        } else {
            await prisma.emailUsage.deleteMany({ where: { apiKeyId } });
        }

        return { success: true };
    },

    /**
     * 获取所有邮箱及其使用状态 (Admin 用)
     */
    async getEmailsWithUsage(apiKeyId: number, groupId?: number) {
        const emailWhere: Prisma.EmailAccountWhereInput = { status: 'ACTIVE' };
        if (groupId !== undefined) {
            emailWhere.groupId = groupId;
        }

        const [emails, usedIds] = await Promise.all([
            prisma.emailAccount.findMany({
                where: emailWhere,
                select: { id: true, email: true, groupId: true, group: { select: { id: true, name: true } } },
                orderBy: { id: 'asc' },
            }),
            prisma.emailUsage.findMany({
                where: { apiKeyId },
                select: { emailAccountId: true },
            }),
        ]);

        const usedSet = new Set(usedIds.map((u: { emailAccountId: number }) => u.emailAccountId));

        return emails.map((e: { id: number; email: string; groupId: number | null; group: { id: number; name: string } | null }) => ({
            id: e.id,
            email: e.email,
            used: usedSet.has(e.id),
            groupId: e.groupId,
            groupName: e.group?.name || null,
        }));
    },

    /**
     * 更新邮箱使用状态 (Admin 用)
     */
    async updateEmailUsage(apiKeyId: number, emailIds: number[]) {
        await prisma.emailUsage.deleteMany({ where: { apiKeyId } });

        if (emailIds.length > 0) {
            await prisma.emailUsage.createMany({
                data: emailIds.map((emailAccountId: number) => ({
                    apiKeyId,
                    emailAccountId,
                })),
                skipDuplicates: true,
            });
        }

        return { success: true, count: emailIds.length };
    },
};
