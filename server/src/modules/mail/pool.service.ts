import prisma from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import { AppError } from '../../plugins/error.js';
import type { Prisma } from '@prisma/client';

interface ApiKeyScope {
    allowedGroupIds?: number[];
    allowedEmailIds?: number[];
}

/** 领取租约（秒）默认值与上下限 */
export const CLAIM_LEASE_DEFAULT_SECONDS = 600;
export const CLAIM_LEASE_MIN_SECONDS = 30;
export const CLAIM_LEASE_MAX_SECONDS = 24 * 60 * 60;

/**
 * "仍占用"的使用记录：已完成，或领取中且租约未过期。
 * 过期的领取记录视为已释放，可被重新分配。
 */
function activeUsageWhere(now: Date = new Date()): Prisma.EmailUsageWhereInput {
    return {
        OR: [
            { status: 'COMPLETED' },
            { status: 'CLAIMED', leaseExpiresAt: { gt: now } },
        ],
    };
}

function expiredClaimWhere(now: Date = new Date()): Prisma.EmailUsageWhereInput {
    return {
        status: 'CLAIMED',
        OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
        ],
    };
}

type AllocationMode =
    | { status: 'COMPLETED' }
    | { status: 'CLAIMED'; leaseSeconds: number };

/**
 * 为 API Key 占用一个邮箱。先清理同一组合上已过期的领取记录，再写入新记录；
 * 并发冲突时抛出 ALREADY_USED，调用方重试即可。
 */
async function allocate(apiKeyId: number, emailAccountId: number, mode: AllocationMode) {
    const now = new Date();
    try {
        return await prisma.$transaction(async (tx) => {
            await tx.emailUsage.deleteMany({
                where: { apiKeyId, emailAccountId, ...expiredClaimWhere(now) },
            });
            return tx.emailUsage.create({
                data: mode.status === 'CLAIMED'
                    ? {
                        apiKeyId,
                        emailAccountId,
                        status: 'CLAIMED',
                        usedAt: now,
                        leaseExpiresAt: new Date(now.getTime() + mode.leaseSeconds * 1000),
                    }
                    : {
                        apiKeyId,
                        emailAccountId,
                        status: 'COMPLETED',
                        usedAt: now,
                        completedAt: now,
                    },
            });
        });
    } catch (error: unknown) {
        if (hasErrorCode(error, 'P2002')) {
            throw new AppError('ALREADY_USED', 'Email already allocated to this API Key', 409);
        }
        throw error;
    }
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
                    some: { apiKeyId, ...activeUsageWhere() },
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
                imapClientId: true,
                imapRefreshToken: true,
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
            imapRefreshToken: email.imapRefreshToken ? decrypt(email.imapRefreshToken) : null,
            fetchStrategy: email.group?.fetchStrategy || 'GRAPH_FIRST',
        };
    },

    /**
     * 标记邮箱已被使用
     */
    async markUsed(apiKeyId: number, emailAccountId: number) {
        await allocate(apiKeyId, emailAccountId, { status: 'COMPLETED' });
    },

    /**
     * 领取一个邮箱（带租约）。租约到期未完成/释放时自动回收。
     * 并发冲突自动重试 3 次。
     */
    async claimEmail(apiKeyId: number, groupName: string | undefined, leaseSeconds: number) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const email = await this.getUnusedEmail(apiKeyId, groupName);
            if (!email) {
                const stats = await this.getStats(apiKeyId, groupName);
                throw new AppError(
                    'NO_UNUSED_EMAIL',
                    `No unused emails available${groupName ? ` in group '${groupName}'` : ''}. Used: ${stats.used}/${stats.total}`,
                    400
                );
            }
            try {
                const usage = await allocate(apiKeyId, email.id, { status: 'CLAIMED', leaseSeconds });
                return {
                    id: email.id,
                    email: email.email,
                    claimedAt: usage.usedAt,
                    leaseExpiresAt: usage.leaseExpiresAt,
                };
            } catch (err: unknown) {
                if (hasErrorCode(err, 'ALREADY_USED')) {
                    continue;
                }
                throw err;
            }
        }
        throw new AppError('CONCURRENCY_LIMIT', 'System busy, please try again', 429);
    },

    /**
     * 完成领取：邮箱标记为已用完，不再分配给该 API Key。重复调用幂等。
     */
    async completeClaim(apiKeyId: number, emailAccountId: number) {
        const usage = await prisma.emailUsage.findUnique({
            where: { apiKeyId_emailAccountId: { apiKeyId, emailAccountId } },
        });
        if (!usage) {
            throw new AppError('CLAIM_NOT_FOUND', 'This email is not claimed by this API Key', 404);
        }
        if (usage.status === 'COMPLETED') {
            return { status: 'COMPLETED' as const, completedAt: usage.completedAt ?? usage.usedAt, alreadyCompleted: true };
        }
        const updated = await prisma.emailUsage.update({
            where: { id: usage.id },
            data: { status: 'COMPLETED', completedAt: new Date(), leaseExpiresAt: null },
        });
        return { status: 'COMPLETED' as const, completedAt: updated.completedAt, alreadyCompleted: false };
    },

    /**
     * 释放领取：邮箱回到池中，可再次被领取。已完成的邮箱不能释放（请用 reset-pool）。
     */
    async releaseClaim(apiKeyId: number, emailAccountId: number) {
        const usage = await prisma.emailUsage.findUnique({
            where: { apiKeyId_emailAccountId: { apiKeyId, emailAccountId } },
            select: { id: true, status: true },
        });
        if (!usage) {
            throw new AppError('CLAIM_NOT_FOUND', 'This email is not claimed by this API Key', 404);
        }
        if (usage.status === 'COMPLETED') {
            throw new AppError('ALREADY_COMPLETED', 'Email already completed and cannot be released', 409);
        }
        await prisma.emailUsage.deleteMany({ where: { id: usage.id, status: 'CLAIMED' } });
        return { released: true };
    },

    /**
     * 该 API Key 对某邮箱的当前占用记录（不含已过期的领取）
     */
    async getActiveUsage(apiKeyId: number, emailAccountId: number) {
        return prisma.emailUsage.findFirst({
            where: { apiKeyId, emailAccountId, ...activeUsageWhere() },
            select: { status: true, usedAt: true, leaseExpiresAt: true },
        });
    },

    /**
     * 清理所有已过期的领取记录（定时任务调用）
     */
    async cleanupExpiredClaims(): Promise<number> {
        const result = await prisma.emailUsage.deleteMany({ where: expiredClaimWhere() });
        return result.count;
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

        const now = new Date();
        const usageWhere: Prisma.EmailUsageWhereInput = {
            apiKeyId,
            emailAccountId: { in: emailIds.length > 0 ? emailIds : [-1] },
        };

        const [completed, claimed] = await Promise.all([
            prisma.emailUsage.count({ where: { ...usageWhere, status: 'COMPLETED' } }),
            prisma.emailUsage.count({ where: { ...usageWhere, status: 'CLAIMED', leaseExpiresAt: { gt: now } } }),
        ]);

        const total = emailIds.length;
        const used = completed + claimed;
        return { total, used, remaining: Math.max(0, total - used), claimed, completed };
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

        await prisma.emailUsage.deleteMany({
            where: {
                apiKeyId,
                emailAccountId: { in: scopedEmailIds },
            },
        });

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
                where: { apiKeyId, ...activeUsageWhere() },
                select: { emailAccountId: true, status: true },
            }),
        ]);

        const usedSet = new Set(usedIds.map((u: { emailAccountId: number }) => u.emailAccountId));
        const claimedSet = new Set(
            usedIds
                .filter((u: { status: string }) => u.status === 'CLAIMED')
                .map((u: { emailAccountId: number }) => u.emailAccountId)
        );

        return emails.map((e: { id: number; email: string; groupId: number | null; group: { id: number; name: string } | null }) => ({
            id: e.id,
            email: e.email,
            used: usedSet.has(e.id),
            claimed: claimedSet.has(e.id),
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

            const now = new Date();
            // 先清理范围内已过期的领取，避免其阻塞重新标记
            await tx.emailUsage.deleteMany({
                where: {
                    apiKeyId,
                    emailAccountId: { in: scopedEmailIds },
                    ...expiredClaimWhere(now),
                },
            });

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
                        status: 'COMPLETED' as const,
                        completedAt: now,
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
