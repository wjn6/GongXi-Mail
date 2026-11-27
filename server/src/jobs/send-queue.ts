/**
 * 发信队列：处理 Resend 批量接口排队的邮件。
 * - 每 5 秒领取一批到期的排队邮件，逐封从池中挑号发送
 * - 暂时没有可用账号（限流 / 额度 / 冷却）时延后重试，超过 24 小时仍未发出则失败
 * - 进程中断导致长时间停在"发送中"的记录标记为失败（无法确认是否已发出，不重发）
 * 同时清理过期的幂等记录。
 */
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { parseMailAddress } from '../lib/send-mail.js';
import { poolService } from '../modules/mail/pool.service.js';
import { cleanupExpiredIdempotency } from '../modules/send/idempotency.service.js';
import { requestFromLog, resolvePreferredSender, sendFromPool } from '../modules/send/send.service.js';

const POLL_INTERVAL_MS = 5_000;
const CLAIM_BATCH_SIZE = 5;
const RETRY_DELAY_SECONDS = 30;
const QUEUE_MAX_AGE_HOURS = 24;
const STALE_LOCK_MINUTES = 10;
const CLEANUP_EVERY_TICKS = 60;

const DB_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

let timer: NodeJS.Timeout | null = null;
let running = false;
let rerunRequested = false;
let stopping = false;
let tick = 0;

async function claimDueEmails(): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE send_logs SET locked_at = ${DB_NOW}
        WHERE id IN (
            SELECT id FROM send_logs
            WHERE status = 'QUEUED'
              AND locked_at IS NULL
              AND (next_attempt_at IS NULL OR next_attempt_at <= ${DB_NOW})
            ORDER BY created_at ASC
            LIMIT ${CLAIM_BATCH_SIZE}
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id
    `;
    return rows.map((row) => row.id);
}

async function recoverStaleRows() {
    // 已领取但未开始发送（进程中断）：释放后重新排队
    await prisma.$executeRaw`
        UPDATE send_logs SET locked_at = NULL
        WHERE status = 'QUEUED' AND locked_at < ${DB_NOW} - make_interval(mins => ${STALE_LOCK_MINUTES}::int)
    `;
    // 发送中断：无法确认 Graph 是否已接收，标记失败避免重复发送
    await prisma.$executeRaw`
        UPDATE send_logs
        SET status = 'FAILED', locked_at = NULL, error_code = 'INTERRUPTED',
            error_message = 'Sending was interrupted; the email may or may not have been sent.'
        WHERE status = 'SENDING' AND locked_at < ${DB_NOW} - make_interval(mins => ${STALE_LOCK_MINUTES}::int)
    `;
}

async function processQueuedEmail(id: string) {
    const log = await prisma.sendLog.findUnique({ where: { id } });
    if (!log || log.status !== 'QUEUED') {
        return;
    }

    const expired = Date.now() - log.createdAt.getTime() > QUEUE_MAX_AGE_HOURS * 60 * 60 * 1000;
    const scope = log.apiKeyId ? await poolService.getApiKeyScope(log.apiKeyId).catch(() => null) : {};
    if (!scope) {
        await prisma.sendLog.update({
            where: { id },
            data: { status: 'FAILED', lockedAt: null, errorCode: 'API_KEY_NOT_FOUND', errorMessage: 'The API key of this email no longer exists.' },
        });
        return;
    }

    const fromAddress = parseMailAddress(log.requestedFrom)?.address;
    const preferredAddress = fromAddress ? await resolvePreferredSender(fromAddress, scope) : undefined;
    const outcome = await sendFromPool(id, requestFromLog(log), { scope, preferredAddress, markFailed: false });
    if (outcome.ok) {
        return;
    }

    if (outcome.retryable && !expired) {
        await prisma.sendLog.update({
            where: { id },
            data: {
                status: 'QUEUED',
                lockedAt: null,
                nextAttemptAt: new Date(Date.now() + RETRY_DELAY_SECONDS * 1000),
                errorCode: outcome.reason,
                errorMessage: outcome.message.slice(0, 2000),
            },
        });
        return;
    }

    await prisma.sendLog.update({
        where: { id },
        data: {
            status: 'FAILED',
            lockedAt: null,
            nextAttemptAt: null,
            errorCode: expired && outcome.retryable ? 'QUEUE_EXPIRED' : outcome.reason,
            errorMessage: (expired && outcome.retryable
                ? `Not sent within ${QUEUE_MAX_AGE_HOURS} hours: ${outcome.message}`
                : outcome.message).slice(0, 2000),
        },
    });
}

async function runOnce() {
    if (stopping) {
        return;
    }
    if (running) {
        rerunRequested = true;
        return;
    }
    running = true;
    try {
        do {
            rerunRequested = false;
            tick++;
            if (tick % CLEANUP_EVERY_TICKS === 1) {
                await recoverStaleRows();
                const deleted = await cleanupExpiredIdempotency();
                if (deleted > 0) {
                    logger.info({ deleted }, 'Expired Resend idempotency keys cleaned up');
                }
            }

            while (!stopping) {
                const ids = await claimDueEmails();
                if (ids.length === 0) break;
                for (const id of ids) {
                    if (stopping) {
                        // 已领取但未处理的记录释放回队列
                        await prisma.sendLog.updateMany({ where: { id, status: 'QUEUED' }, data: { lockedAt: null } }).catch(() => undefined);
                        continue;
                    }
                    try {
                        await processQueuedEmail(id);
                    } catch (err) {
                        logger.error({ err, sendLogId: id }, 'Failed to process queued email');
                        await prisma.sendLog.updateMany({
                            where: { id, status: { in: ['QUEUED', 'SENDING'] } },
                            data: {
                                status: 'QUEUED',
                                lockedAt: null,
                                nextAttemptAt: new Date(Date.now() + RETRY_DELAY_SECONDS * 1000),
                            },
                        }).catch(() => undefined);
                    }
                }
            }
        } while (rerunRequested && !stopping);
    } catch (err) {
        logger.error({ err }, 'Send queue run failed');
    } finally {
        running = false;
    }
}

/** 有新排队邮件时立即处理（不等下一次轮询） */
export function kickSendQueue() {
    void runOnce();
}

export function startSendQueueJob(): () => void {
    stopping = false;
    void runOnce();
    timer = setInterval(() => {
        void runOnce();
    }, POLL_INTERVAL_MS);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
    // 停止：不再领取新邮件；正在发送的一封如果被进程退出打断，会在下次启动时标记为 INTERRUPTED（不会重复发送）
    return () => {
        stopping = true;
        if (timer) clearInterval(timer);
        timer = null;
    };
}
