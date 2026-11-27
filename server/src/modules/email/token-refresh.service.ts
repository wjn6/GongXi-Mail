import prisma from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { proxyFetch } from '../../lib/proxy.js';
import { env } from '../../config/env.js';
import type { Prisma } from '@prisma/client';
import { formatOAuthFailure, parseOAuthTokenError } from '../../lib/oauth-error.js';

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

interface OAuthTokenResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
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

function getFailureUpdateData(existingErrorMessage: string | null, message: string) {
    if (existingErrorMessage && !existingErrorMessage.startsWith(TOKEN_REFRESH_ERROR_PREFIX)) {
        return {};
    }

    return {
        errorMessage: formatTokenRefreshError(message),
    };
}

function getSuccessUpdateData(existingErrorMessage: string | null) {
    if (existingErrorMessage?.startsWith(TOKEN_REFRESH_ERROR_PREFIX)) {
        return { errorMessage: null };
    }

    return {};
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
            logger.error({ emailId, email: account.email }, '解密 refresh token 失败');
            await prisma.emailAccount.update({
                where: { id: emailId },
                data: getFailureUpdateData(account.errorMessage, 'Failed to decrypt refresh token'),
            });
            return { emailId, email: account.email, success: false, message: 'Failed to decrypt refresh token' };
        }

        try {
            const response = await proxyFetch(
                'https://login.microsoftonline.com/common/oauth2/v2.0/token',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        grant_type: 'refresh_token',
                        refresh_token: currentRefreshToken,
                        client_id: account.clientId,
                    }).toString(),
                }
            );

            if (!response.ok) {
                const errorText = await response.text();
                // 去掉 Trace ID 等噪声，账号层面的问题（如 refresh token 失效）附带处理建议
                const errorMsg = formatOAuthFailure(parseOAuthTokenError(response.status, errorText));

                logger.warn({ email: account.email, emailId, status: response.status }, `Token 刷新失败: ${errorMsg}`);
                await prisma.emailAccount.update({
                    where: { id: emailId },
                    data: getFailureUpdateData(account.errorMessage, errorMsg),
                });
                return { emailId, email: account.email, success: false, message: errorMsg.substring(0, 200) };
            }

            const data = await response.json() as OAuthTokenResponse;

            if (!data.refresh_token) {
                const msg = 'No refresh_token in response';
                logger.warn({ email: account.email, emailId }, '响应中缺少 refresh_token');
                await prisma.emailAccount.update({
                    where: { id: emailId },
                    data: getFailureUpdateData(account.errorMessage, msg),
                });
                return { emailId, email: account.email, success: false, message: msg };
            }

            const encryptedNewToken = encrypt(data.refresh_token);
            await prisma.emailAccount.update({
                where: { id: emailId },
                data: {
                    refreshToken: encryptedNewToken,
                    tokenRefreshedAt: new Date(),
                    ...getSuccessUpdateData(account.errorMessage),
                },
            });

            logger.info({ email: account.email, emailId }, 'Token 刷新成功');
            return { emailId, email: account.email, success: true, message: 'OK' };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger.error({ err, email: account.email, emailId }, 'Token 刷新异常');
            await prisma.emailAccount.update({
                where: { id: emailId },
                data: getFailureUpdateData(account.errorMessage, `Exception: ${message}`),
            });
            return { emailId, email: account.email, success: false, message: message.substring(0, 200) };
        }
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
