/**
 * 长轮询等待验证码的核心逻辑（纯函数，不依赖数据库 / 环境配置，便于测试）。
 * 拉取邮件的方式由调用方注入。
 */
import {
    extractVerificationCode,
    getMessageMatchText,
    matchWithUserRegex,
} from './verification-code.js';

export const WAIT_CODE_TIMEOUT_DEFAULT_SECONDS = 60;
export const WAIT_CODE_TIMEOUT_MIN_SECONDS = 5;
export const WAIT_CODE_TIMEOUT_MAX_SECONDS = 180;
export const WAIT_CODE_INTERVAL_DEFAULT_SECONDS = 5;
export const WAIT_CODE_INTERVAL_MIN_SECONDS = 3;
export const WAIT_CODE_INTERVAL_MAX_SECONDS = 30;
/** 单个 API Key 同时进行的等待请求上限 */
export const WAIT_CODE_MAX_CONCURRENT_PER_KEY = 10;

export interface WaitCodeMessage {
    id: string;
    from: string;
    subject: string;
    text: string;
    html: string;
    date: string;
}

export interface WaitCodeFetchResult {
    messages: WaitCodeMessage[];
    method: string;
}

export type WaitCodeFetcher = (mailbox: string) => Promise<WaitCodeFetchResult>;

export interface WaitCodeOptions {
    mailboxes: string[];
    since: Date;
    timeoutMs: number;
    intervalMs: number;
    regex?: RegExp;
    signal?: AbortSignal;
    /** 非首轮拉取失败时回调（首轮失败直接抛出） */
    onRetryError?: (err: unknown, mailbox: string, attempt: number) => void;
}

export interface WaitCodeResult {
    code: string;
    matchedBy: 'regex' | 'auto';
    mailbox: string;
    messageId: string;
    subject: string;
    from: string;
    receivedAt: string;
    method: string;
    attempts: number;
    waitedMs: number;
}

const activeWaitsByKey = new Map<number, number>();

/**
 * 占用一个等待名额，返回释放函数（可重复调用）；超过单 Key 并发上限时返回 null。
 */
export function acquireWaitSlot(apiKeyId: number): (() => void) | null {
    const current = activeWaitsByKey.get(apiKeyId) ?? 0;
    if (current >= WAIT_CODE_MAX_CONCURRENT_PER_KEY) {
        return null;
    }
    activeWaitsByKey.set(apiKeyId, current + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next = (activeWaitsByKey.get(apiKeyId) ?? 1) - 1;
        if (next <= 0) {
            activeWaitsByKey.delete(apiKeyId);
        } else {
            activeWaitsByKey.set(apiKeyId, next);
        }
    };
}

/**
 * 解析 since 参数：支持 ISO 时间、秒级或毫秒级时间戳。
 * 未传返回 undefined，无法解析返回 null。
 */
export function parseSinceParam(value: string | number | undefined): Date | undefined | null {
    if (value === undefined || value === '') {
        return undefined;
    }
    const raw = typeof value === 'number' ? String(value) : value.trim();
    let date: Date;
    if (/^\d+$/.test(raw)) {
        const num = Number(raw);
        date = new Date(raw.length <= 10 ? num * 1000 : num);
    } else {
        date = new Date(raw);
    }
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 默认起始时间：
 * - 该 Key 持有此邮箱（领取中或已分配）时，从分配时间开始，但不早于 10 分钟前；
 * - 否则从请求前 60 秒开始。
 */
export function resolveDefaultSince(now: Date, allocatedAt?: Date | null): Date {
    if (allocatedAt) {
        const floor = now.getTime() - 10 * 60 * 1000;
        return new Date(Math.max(allocatedAt.getTime(), floor));
    }
    return new Date(now.getTime() - 60 * 1000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function toTime(value: string): number | null {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
}

/**
 * 轮询直到出现 since 之后到达、且能提取出验证码的邮件。
 * 超时或被中止时返回 null；首轮拉取失败直接抛错，后续瞬时错误回调后继续。
 */
export async function waitForVerificationCode(
    fetchMessages: WaitCodeFetcher,
    options: WaitCodeOptions
): Promise<WaitCodeResult | null> {
    const startedAt = Date.now();
    const deadline = startedAt + options.timeoutMs;
    const sinceTime = options.since.getTime();
    let attempts = 0;

    while (!options.signal?.aborted) {
        attempts++;
        for (const mailbox of options.mailboxes) {
            let result: WaitCodeFetchResult;
            try {
                result = await fetchMessages(mailbox);
            } catch (err) {
                if (attempts === 1) {
                    throw err;
                }
                options.onRetryError?.(err, mailbox, attempts);
                continue;
            }

            const candidates = (result.messages || [])
                .map((message) => ({ message, time: toTime(message.date) }))
                .filter((item): item is { message: WaitCodeMessage; time: number } =>
                    item.time !== null && item.time >= sinceTime
                )
                .sort((a, b) => b.time - a.time);

            for (const { message, time } of candidates) {
                const body = getMessageMatchText(message.text, message.html);
                const code = options.regex
                    ? matchWithUserRegex(options.regex, message.subject, body)
                    : extractVerificationCode(message.subject, body);
                if (code) {
                    return {
                        code,
                        matchedBy: options.regex ? 'regex' : 'auto',
                        mailbox,
                        messageId: message.id,
                        subject: message.subject,
                        from: message.from,
                        receivedAt: new Date(time).toISOString(),
                        method: result.method,
                        attempts,
                        waitedMs: Date.now() - startedAt,
                    };
                }
            }
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0 || options.signal?.aborted) {
            break;
        }
        await sleep(Math.min(options.intervalMs, remaining), options.signal);
    }

    return null;
}
