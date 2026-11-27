import prisma from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import type { Prisma } from '@prisma/client';
import { formatOAuthFailure, isAccountLevelOAuthFailure } from '../../lib/oauth-error.js';
import { exchangeRefreshToken, normalizeOAuthTenant } from '../../lib/ms-oauth.js';

export type TokenRefreshTrigger = 'AUTO' | 'MANUAL';

interface RefreshResult {
    emailId: number;
    email: string;
    success: boolean;
    message: string;
}

interface BatchRefreshSummary {
    total: number;
    success: number;
    failed: number;
    durationMs: number;
}

interface BatchRefreshResult extends BatchRefreshSummary {
    trigger: TokenRefreshTrigger;
    groupId: number | null;
    requestedById: number | null;
    requestedByUsername: string | null;
    startedAt: Date;
    completedAt: Date;
    results: RefreshResult[];
}

interface CurrentRefreshRun extends BatchRefreshSummary {
    trigger: TokenRefreshTrigger;
    groupId: number | null;
    requestedById: number | null;
    requestedByUsername: string | null;
    completed: number;
    startedAt: Date;
    completedAt: Date | null;
    recentFailures: RefreshResult[];
}

interface RefreshStats {
    lastRunAt: Date | null;
    nextRunAt: Date | null;
    isRunning: boolean;
    lastResult: BatchRefreshSummary | null;
    currentRun: CurrentRefreshRun | null;
    recentFailures: RefreshResult[];
}

interface TokenRefreshConfig {
    enabled: boolean;
    intervalHours: number;
    concurrency: number;
}

interface TokenRefreshScheduleState extends TokenRefreshConfig {
    lastRunAt: Date | null;
    nextRunAt: Date | null;
}

interface RefreshAllOptions {
    concurrency?: number;
    groupId?: number;
    trigger?: TokenRefreshTrigger;
    requestedBy?: {
        id: number;
        username: string;
    } | null;
}


const TOKEN_REFRESH_ERROR_PREFIX = 'Token refresh';
const SYSTEM_CONFIG_ID = 1;
const RECENT_FAILURE_LIMIT = 10;

const systemConfigSelect = {
    tokenRefreshEnabled: true,
    tokenRefreshIntervalHours: true,
    tokenRefreshConcurrency: true,
    tokenRefreshNextRunAt: true,
    tokenRefreshLastAutoCompletedAt: true,
    tokenRefreshLastAutoTotal: true,
    tokenRefreshLastAutoSuccess: true,
    tokenRefreshLastAutoFailed: true,
    tokenRefreshLastAutoDurationMs: true,
    tokenRefreshLastAutoFailures: true,
} satisfies Prisma.SystemConfigSelect;

type SystemConfigSnapshot = Prisma.SystemConfigGetPayload<{
    select: typeof systemConfigSelect;
}>;

const defaultSystemConfigCreate = {
    id: SYSTEM_CONFIG_ID,
    tokenRefreshEnabled: env.TOKEN_REFRESH_ENABLED,
    tokenRefreshIntervalHours: env.TOKEN_REFRESH_INTERVAL_HOURS,
    tokenRefreshConcurrency: env.TOKEN_REFRESH_CONCURRENCY,
};

// 模块级运行态
let isRunning = false;
let currentRun: CurrentRefreshRun | null = null;

/**
 * 并发控制工具：限制同时执行的 Promise 数量
 */
async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>
): Promise<void> {
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const currentIndex = index++;
            await fn(items[currentIndex]);
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker()
    );
    await Promise.all(workers);
}

function formatTokenRefreshError(message: string): string {
    return `${TOKEN_REFRESH_ERROR_PREFIX}: ${message}`.substring(0, 500);
}

function getFailureUpdateData(
    account: { status: string; errorMessage: string | null },
    message: string,
    accountLevel: boolean
): Prisma.EmailAccountUpdateInput {
    // 刷新令牌本身失效（如 AADSTS70000）：标记为异常，邮箱池不再分配、发信池不再使用
    // 网络等临时问题：只记录原因，不改变状态
    return {
        errorMessage: formatTokenRefreshError(message),
        ...(accountLevel && account.status === 'ACTIVE' ? { status: 'ERROR' as const } : {}),
    };
}

function getSuccessUpdateData(account: { status: string; errorMessage: string | null }): Prisma.EmailAccountUpdateInput {
    // 令牌可用：清除错误；之前因异常被标记的账号恢复正常（禁用的账号不会被刷新）
    return {
        errorMessage: null,
        ...(account.status === 'ERROR' ? { status: 'ACTIVE' as const } : {}),
    };
}

function mapSystemConfigToTokenRefreshConfig(config: SystemConfigSnapshot): TokenRefreshConfig {
    return {
        enabled: config.tokenRefreshEnabled,
        intervalHours: config.tokenRefreshIntervalHours,
        concurrency: config.tokenRefreshConcurrency,
    };
}

function appendRecentFailure(target: RefreshResult[], result: RefreshResult) {
    target.push(result);
    if (target.length > RECENT_FAILURE_LIMIT) {
        target.splice(0, target.length - RECENT_FAILURE_LIMIT);
    }
}

function buildLastResult(config: SystemConfigSnapshot): BatchRefreshSummary | null {
    if (
        config.tokenRefreshLastAutoTotal === null ||
        config.tokenRefreshLastAutoSuccess === null ||
        config.tokenRefreshLastAutoFailed === null ||
        config.tokenRefreshLastAutoDurationMs === null
    ) {
        return null;
    }

    return {
        total: config.tokenRefreshLastAutoTotal,
        success: config.tokenRefreshLastAutoSuccess,
        failed: config.tokenRefreshLastAutoFailed,
        durationMs: config.tokenRefreshLastAutoDurationMs,
    };
}

function parseStoredFailures(value: Prisma.JsonValue | null): RefreshResult[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return null;
            }

            const record = item as Record<string, unknown>;
            if (
                typeof record.emailId !== 'number' ||
                typeof record.email !== 'string' ||
                typeof record.success !== 'boolean' ||
                typeof record.message !== 'string'
            ) {
                return null;
            }

            return {
                emailId: record.emailId,
                email: record.email,
                success: record.success,
                message: record.message,
            } satisfies RefreshResult;
        })
        .filter((item): item is RefreshResult => item !== null);
}

function serializeFailures(failures: RefreshResult[]): Prisma.InputJsonValue {
    return failures.map((failure) => ({
        emailId: failure.emailId,
        email: failure.email,
        success: failure.success,
        message: failure.message,
    })) as Prisma.InputJsonValue;
}

async function getSystemConfigSnapshot(): Promise<SystemConfigSnapshot> {
    return prisma.systemConfig.upsert({
        where: { id: SYSTEM_CONFIG_ID },
        update: {},
        create: defaultSystemConfigCreate,
        select: systemConfigSelect,
    });
}

export const tokenRefreshService = {
    async getTokenRefreshConfig(): Promise<TokenRefreshConfig> {
        const config = await getSystemConfigSnapshot();
        return mapSystemConfigToTokenRefreshConfig(config);
    },

    async getTokenRefreshScheduleState(): Promise<TokenRefreshScheduleState> {
        const config = await getSystemConfigSnapshot();
        return {
            ...mapSystemConfigToTokenRefreshConfig(config),
            lastRunAt: config.tokenRefreshLastAutoCompletedAt,
            nextRunAt: config.tokenRefreshNextRunAt,
        };
    },

    async getRefreshStats(nextRunAtOverride: Date | null = null): Promise<RefreshStats> {
        const config = await getSystemConfigSnapshot();
        const lastResult = buildLastResult(config);
        return {
            lastRunAt: config.tokenRefreshLastAutoCompletedAt,
            nextRunAt: nextRunAtOverride ?? config.tokenRefreshNextRunAt,
            isRunning,
            lastResult,
            currentRun,
            recentFailures: currentRun?.trigger === 'AUTO'
                ? currentRun.recentFailures.slice().reverse()
                : parseStoredFailures(config.tokenRefreshLastAutoFailures),
        };
    },

    async updateTokenRefreshConfig(input: TokenRefreshConfig): Promise<TokenRefreshConfig> {
        const config = await prisma.systemConfig.upsert({
            where: { id: SYSTEM_CONFIG_ID },
            update: {
                tokenRefreshEnabled: input.enabled,
                tokenRefreshIntervalHours: input.intervalHours,
                tokenRefreshConcurrency: input.concurrency,
            },
            create: {
                ...defaultSystemConfigCreate,
                tokenRefreshEnabled: input.enabled,
                tokenRefreshIntervalHours: input.intervalHours,
                tokenRefreshConcurrency: input.concurrency,
            },
            select: systemConfigSelect,
        });

        return mapSystemConfigToTokenRefreshConfig(config);
    },

    async updateNextAutoRunAt(nextRunAt: Date | null): Promise<void> {
        await prisma.systemConfig.upsert({
            where: { id: SYSTEM_CONFIG_ID },
            update: {
                tokenRefreshNextRunAt: nextRunAt,
            },
            create: {
                ...defaultSystemConfigCreate,
                tokenRefreshNextRunAt: nextRunAt,
            },
        });
    },

    isRefreshRunning(): boolean {
        return isRunning;
    },

    isAutoRunInProgress(): boolean {
        return currentRun?.trigger === 'AUTO';
    },

    getCurrentRun(): CurrentRefreshRun | null {
        return currentRun;
    },

    /**
     * 刷新单个邮箱的 Refresh Token
     */
    async refreshSingleToken(emailId: number): Promise<RefreshResult> {
        const account = await prisma.emailAccount.findUnique({
            where: { id: emailId },
            select: {
                id: true,
                email: true,
                clientId: true,
                refreshToken: true,
                status: true,
                errorMessage: true,
                group: { select: { oauthTenant: true } },
            },
        });

        if (!account) {
            return { emailId, email: '', success: false, message: 'Email account not found' };
        }

        if (account.status === 'DISABLED') {
            return { emailId, email: account.email, success: false, message: 'Email account is disabled' };
        }

        let currentRefreshToken: string;
        try {
            currentRefreshToken = decrypt(account.refreshToken);
        } catch {
            const msg = 'Failed to decrypt refresh token (was ENCRYPTION_KEY changed?)';
            logger.error({ emailId, email: account.email }, '解密 refresh token 失败');
            await prisma.emailAccount.update({
                where: { id: emailId },
                data: getFailureUpdateData(account, msg, true),
            });
            return { emailId, email: account.email, success: false, message: msg };
        }

        const tenant = normalizeOAuthTenant(account.group?.oauthTenant);
        const result = await exchangeRefreshToken({
            clientId: account.clientId,
            refreshToken: currentRefreshToken,
            tenant,
        });

        if (!result.ok) {
            const accountLevel = isAccountLevelOAuthFailure(result.failure);
            // 去掉 Trace ID 等噪声，账号层面的问题（如 refresh token 失效）附带处理建议
            const errorMsg = formatOAuthFailure(result.failure);
            logger.warn({
                email: account.email,
                emailId,
                tenant,
                status: result.failure.status,
                kind: result.failure.kind,
                aadsts: result.failure.aadsts,
            }, `Token 刷新失败: ${errorMsg}`);
            await prisma.emailAccount.update({
                where: { id: emailId },
                data: getFailureUpdateData(account, errorMsg, accountLevel),
            });
            return { emailId, email: account.email, success: false, message: errorMsg.substring(0, 300) };
        }

        // 微软通常会返回新的 refresh token（轮换）；没有返回时旧令牌仍然有效，继续使用
        const rotated = !!result.refreshToken && result.refreshToken !== currentRefreshToken;
        await prisma.emailAccount.update({
            where: { id: emailId },
            data: {
                ...(rotated ? { refreshToken: encrypt(result.refreshToken!) } : {}),
                tokenRefreshedAt: new Date(),
                ...getSuccessUpdateData(account),
            },
        });

        logger.info({ email: account.email, emailId, tenant, rotated }, 'Token 刷新成功');
        return {
            emailId,
            email: account.email,
            success: true,
            message: rotated ? 'OK' : 'OK (Microsoft did not rotate the refresh token; the current one is still valid)',
        };
    },

    /**
     * 批量刷新所有未禁用邮箱
     */
    async refreshAll(options?: RefreshAllOptions): Promise<BatchRefreshResult> {
        const trigger = options?.trigger ?? 'MANUAL';
        const groupId = options?.groupId ?? null;
        const requestedById = options?.requestedBy?.id ?? null;
        const requestedByUsername = options?.requestedBy?.username ?? null;

        if (isRunning) {
            return {
                trigger,
                groupId,
                requestedById,
                requestedByUsername,
                total: 0,
                success: 0,
                failed: 0,
                durationMs: 0,
                startedAt: new Date(),
                completedAt: new Date(),
                results: [],
            };
        }

        isRunning = true;
        const startedAt = new Date();

        try {
            const where: Prisma.EmailAccountWhereInput = {
                status: { not: 'DISABLED' },
            };
            if (groupId) {
                where.groupId = groupId;
            }

            const accounts = await prisma.emailAccount.findMany({
                where,
                select: { id: true },
                orderBy: { id: 'asc' },
            });

            const config = await this.getTokenRefreshConfig();
            const concurrency = options?.concurrency || config.concurrency;
            const results: RefreshResult[] = [];
            currentRun = {
                trigger,
                groupId,
                requestedById,
                requestedByUsername,
                total: accounts.length,
                completed: 0,
                success: 0,
                failed: 0,
                startedAt,
                completedAt: null,
                durationMs: 0,
                recentFailures: [],
            };

            logger.info({
                systemEvent: true,
                action: trigger === 'AUTO' ? 'token_refresh.auto_started' : 'token_refresh.manual_started',
                trigger,
                groupId,
                requestedById,
                requestedByUsername,
                total: accounts.length,
                concurrency,
            }, trigger === 'AUTO' ? '自动批量刷新 Token 开始' : '手动批量刷新 Token 开始');

            await runWithConcurrency(accounts, concurrency, async (account) => {
                const result = await this.refreshSingleToken(account.id);
                results.push(result);
                if (!currentRun) {
                    return;
                }

                currentRun.completed += 1;
                currentRun.durationMs = Date.now() - startedAt.getTime();
                if (result.success) {
                    currentRun.success += 1;
                } else {
                    currentRun.failed += 1;
                    appendRecentFailure(currentRun.recentFailures, result);
                }
            });

            const completedAt = new Date();
            const batchResult: BatchRefreshResult = {
                trigger,
                groupId,
                requestedById,
                requestedByUsername,
                total: accounts.length,
                success: results.filter((item) => item.success).length,
                failed: results.filter((item) => !item.success).length,
                durationMs: completedAt.getTime() - startedAt.getTime(),
                startedAt,
                completedAt,
                results,
            };

            if (currentRun) {
                currentRun.completedAt = completedAt;
                currentRun.durationMs = batchResult.durationMs;
            }

            if (trigger === 'AUTO') {
                await prisma.systemConfig.upsert({
                    where: { id: SYSTEM_CONFIG_ID },
                    update: {
                        tokenRefreshLastAutoCompletedAt: completedAt,
                        tokenRefreshLastAutoTotal: batchResult.total,
                        tokenRefreshLastAutoSuccess: batchResult.success,
                        tokenRefreshLastAutoFailed: batchResult.failed,
                        tokenRefreshLastAutoDurationMs: batchResult.durationMs,
                        tokenRefreshLastAutoFailures: serializeFailures(
                            results.filter((item) => !item.success).slice(-RECENT_FAILURE_LIMIT)
                        ),
                    },
                    create: {
                        ...defaultSystemConfigCreate,
                        tokenRefreshLastAutoCompletedAt: completedAt,
                        tokenRefreshLastAutoTotal: batchResult.total,
                        tokenRefreshLastAutoSuccess: batchResult.success,
                        tokenRefreshLastAutoFailed: batchResult.failed,
                        tokenRefreshLastAutoDurationMs: batchResult.durationMs,
                        tokenRefreshLastAutoFailures: serializeFailures(
                            results.filter((item) => !item.success).slice(-RECENT_FAILURE_LIMIT)
                        ),
                    },
                });
            }

            logger.info({
                systemEvent: true,
                action: trigger === 'AUTO' ? 'token_refresh.auto_completed' : 'token_refresh.manual_completed',
                trigger,
                groupId,
                requestedById,
                requestedByUsername,
                total: batchResult.total,
                success: batchResult.success,
                failed: batchResult.failed,
                durationMs: batchResult.durationMs,
            }, trigger === 'AUTO' ? '自动批量刷新 Token 完成' : '手动批量刷新 Token 完成');

            return batchResult;
        } catch (err) {
            logger.error({
                err,
                systemEvent: true,
                action: trigger === 'AUTO' ? 'token_refresh.auto_failed' : 'token_refresh.manual_failed',
                trigger,
                groupId,
                requestedById,
                requestedByUsername,
            }, trigger === 'AUTO' ? '自动批量刷新 Token 失败' : '手动批量刷新 Token 失败');
            throw err;
        } finally {
            isRunning = false;
            currentRun = null;
        }
    },
};

