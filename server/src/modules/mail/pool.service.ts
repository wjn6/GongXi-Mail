import prisma from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import { AppError } from '../../plugins/error.js';
import type { Prisma } from '@prisma/client';

interface ApiKeyScope {
    allowedGroupIds?: number[];
    allowedEmailIds?: number[];
}

function hasErrorCode(error: unknown, code: string): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    return (error as { code?: unknown }).code === code;
}

function parseJsonIdList(value: Prisma.JsonValue | null | undefined): number[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return Array.from(
        new Set(
            value
                .map((item) => Number(item))
                .filter((item) => Number.isInteger(item) && item > 0)
        )
    );
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

async function getApiKeyScope(apiKeyId: number): Promise<ApiKeyScope> {
    const apiKey = await prisma.apiKey.findUnique({
        where: { id: apiKeyId },
        select: {
            id: true,
            allowedGroupIds: true,
            allowedEmailIds: true,
        },
    });

    if (!apiKey) {
        throw new AppError('API_KEY_NOT_FOUND', 'API Key not found', 404);
    }

    const allowedGroupIds = parseJsonIdList(apiKey.allowedGroupIds);
    const allowedEmailIds = parseJsonIdList(apiKey.allowedEmailIds);

    return {
        allowedGroupIds: allowedGroupIds.length > 0 ? allowedGroupIds : undefined,
        allowedEmailIds: allowedEmailIds.length > 0 ? allowedEmailIds : undefined,
    };
}

function isEmailInScope(scope: ApiKeyScope, emailId: number, groupId: number | null): boolean {
    if (scope.allowedGroupIds && (!groupId || !scope.allowedGroupIds.includes(groupId))) {
        return false;
    }
    if (scope.allowedEmailIds && !scope.allowedEmailIds.includes(emailId)) {
        return false;
    }
    return true;
}

function applyScopeToEmailWhere(
    where: Prisma.EmailAccountWhereInput,
    scope: ApiKeyScope,
    groupId?: number
): Prisma.EmailAccountWhereInput {
    if (groupId !== undefined) {
        if (scope.allowedGroupIds && !scope.allowedGroupIds.includes(groupId)) {
            throw new AppError('GROUP_FORBIDDEN', 'This API Key cannot access the selected group', 403);
        }
        where.groupId = groupId;
    } else if (scope.allowedGroupIds) {
        where.groupId = { in: scope.allowedGroupIds };
    }

    if (scope.allowedEmailIds) {
        where.id = { in: scope.allowedEmailIds };
    }

    return where;
}

export const poolService = {
    async getApiKeyScope(apiKeyId: number): Promise<ApiKeyScope> {
        return getApiKeyScope(apiKeyId);
    },

    async assertEmailAccessible(apiKeyId: number, emailId: number, groupId: number | null): Promise<void> {
        const scope = await getApiKeyScope(apiKeyId);
        if (!isEmailInScope(scope, emailId, groupId)) {
            throw new AppError('EMAIL_FORBIDDEN', 'This API Key cannot access this email', 403);
        }
    },

    /**
     * 获取未被该 API Key 使用过的邮箱（可按分组过滤）
     */
    async getUnusedEmail(apiKeyId: number, groupName?: string) {
        const scope = await getApiKeyScope(apiKeyId);
        const groupId = await resolveGroupId(groupName);

        const where = applyScopeToEmailWhere({
            status: 'ACTIVE',
            NOT: {
                usages: {
                    some: { apiKeyId },
                },
            },
        }, scope, groupId);

        const email = await prisma.emailAccount.findFirst({
            where,
            select: {
                id: true,
                email: true,
                clientId: true,
                refreshToken: true,
                groupId: true,
                group: {
                    select: {
                        fetchStrategy: true,
                    },
                },
            },
            orderBy: { id: 'asc' },
        });

        if (!email) {
            return null;
        }

        return {
            ...email,
            refreshToken: decrypt(email.refreshToken),
            fetchStrategy: email.group?.fetchStrategy || 'GRAPH_FIRST',
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
        const scope = await getApiKeyScope(apiKeyId);
        const groupId = await resolveGroupId(groupName);

        const emailWhere = applyScopeToEmailWhere({ status: 'ACTIVE' }, scope, groupId);

        // 获取该分组中的邮箱 ID 集合
        const emailIds = (await prisma.emailAccount.findMany({
            where: emailWhere,
            select: { id: true },
        })).map((e: { id: number }) => e.id);

        const usageWhere: Prisma.EmailUsageWhereInput = { apiKeyId };
        if (emailIds.length > 0) {
            usageWhere.emailAccountId = { in: emailIds };
        } else {
            usageWhere.emailAccountId = { in: [-1] };
        }

        const [total, used] = await Promise.all([
            Promise.resolve(emailIds.length),
            prisma.emailUsage.count({ where: usageWhere }),
        ]);

        return { total, used, remaining: Math.max(0, total - used) };
    },

    /**
     * 重置使用记录（可按分组过滤）
     */
    async reset(apiKeyId: number, groupName?: string) {
        const scope = await getApiKeyScope(apiKeyId);
        const groupId = await resolveGroupId(groupName);

        const scopedEmailIds = (await prisma.emailAccount.findMany({
            where: applyScopeToEmailWhere({ status: 'ACTIVE' }, scope, groupId),
            select: { id: true },
        })).map((e: { id: number }) => e.id);

        if (scopedEmailIds.length === 0) {
            return { success: true };
        }

        if (groupId !== undefined) {
            // 仅重置该分组的邮箱使用记录
            await prisma.emailUsage.deleteMany({
                where: {
                    apiKeyId,
                    emailAccountId: { in: scopedEmailIds },
                },
            });
        } else {
            await prisma.emailUsage.deleteMany({
                where: {
                    apiKeyId,
                    emailAccountId: { in: scopedEmailIds },
                },
            });
        }

        return { success: true };
    },

    /**
     * 获取所有邮箱及其使用状态 (Admin 用)
     */
    async getEmailsWithUsage(apiKeyId: number, groupId?: number) {
        const scope = await getApiKeyScope(apiKeyId);
        const emailWhere = applyScopeToEmailWhere({ status: 'ACTIVE' }, scope, groupId);

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
    async updateEmailUsage(apiKeyId: number, emailIds: number[], groupId?: number) {
        return prisma.$transaction(async (tx) => {
            const apiKey = await tx.apiKey.findUnique({
                where: { id: apiKeyId },
                select: {
                    id: true,
                    allowedGroupIds: true,
                    allowedEmailIds: true,
                },
            });
            if (!apiKey) {
                throw new AppError('API_KEY_NOT_FOUND', 'API Key not found', 404);
            }

            const scope: ApiKeyScope = {
                allowedGroupIds: parseJsonIdList(apiKey.allowedGroupIds),
                allowedEmailIds: parseJsonIdList(apiKey.allowedEmailIds),
            };
            if (scope.allowedGroupIds && scope.allowedGroupIds.length === 0) scope.allowedGroupIds = undefined;
            if (scope.allowedEmailIds && scope.allowedEmailIds.length === 0) scope.allowedEmailIds = undefined;

            const scopedWhere = applyScopeToEmailWhere({ status: 'ACTIVE' }, scope, groupId);
            const scopedEmailIds = (await tx.emailAccount.findMany({
                where: scopedWhere,
                select: { id: true },
            })).map((item: { id: number }) => item.id);
            const scopedEmailIdSet = new Set(scopedEmailIds);

            const uniqueRequestedIds = Array.from(new Set(emailIds.filter((id: number) => Number.isInteger(id) && id > 0)));
            const invalidIds = uniqueRequestedIds.filter((id: number) => !scopedEmailIdSet.has(id));
            if (invalidIds.length > 0) {
                throw new AppError('EMAIL_FORBIDDEN', 'Some selected emails are outside API Key scope', 403);
            }

            const nextEmailIds = uniqueRequestedIds;

            const existingUsages = await tx.emailUsage.findMany({
                where: {
                    apiKeyId,
                    emailAccountId: { in: scopedEmailIds },
                },
                select: { emailAccountId: true },
            });

            const existingIdSet = new Set(existingUsages.map((usage: { emailAccountId: number }) => usage.emailAccountId));
            const nextIdSet = new Set(nextEmailIds);

            const toAdd = nextEmailIds.filter((id: number) => !existingIdSet.has(id));
            const toRemove = existingUsages
                .map((usage: { emailAccountId: number }) => usage.emailAccountId)
                .filter((id: number) => !nextIdSet.has(id));

            if (toRemove.length > 0) {
                await tx.emailUsage.deleteMany({
                    where: {
                        apiKeyId,
                        emailAccountId: { in: toRemove },
                    },
                });
            }

            if (toAdd.length > 0) {
                await tx.emailUsage.createMany({
                    data: toAdd.map((emailAccountId: number) => ({
                        apiKeyId,
                        emailAccountId,
                    })),
                    skipDuplicates: true,
                });
            }

            return {
                success: true,
                count: nextEmailIds.length,
                added: toAdd.length,
                removed: toRemove.length,
            };
        });
    },
};
