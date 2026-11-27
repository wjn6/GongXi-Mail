import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let redis: Redis | null = null;

export function getRedis(): Redis | null {
    if (!env.REDIS_URL) {
        return null;
    }

    if (!redis) {
        redis = new Redis(env.REDIS_URL, {
            maxRetriesPerRequest: 3,
            lazyConnect: true,
        });

        redis.on('connect', () => {
            logger.info('Redis connected');
        });

        redis.on('error', (err) => {
            logger.error({ err }, 'Redis connection error');
        });
    }

    return redis;
}

export async function closeRedis(): Promise<void> {
    if (redis) {
        await redis.quit();
        redis = null;
    }
}

/**
 * 缓存设置
 */
export async function setCache(key: string, value: string, expireSeconds: number = 60): Promise<boolean> {
    const client = getRedis();
    if (!client) {
        return false;
    }

    try {
        await client.setex(key, expireSeconds, value);
        logger.debug({ key }, 'Cache set');
        return true;
    } catch (err) {
        logger.error({ err, key }, 'Failed to set cache');
        return false;
    }
}

/**
 * 缓存获取
 */
export async function getCache(key: string): Promise<string | null> {
    const client = getRedis();
    if (!client) {
        return null;
    }

    try {
        const value = await client.get(key);
        if (value) {
            logger.debug({ key }, 'Cache hit');
        }
        return value;
    } catch (err) {
        logger.error({ err, key }, 'Failed to get cache');
        return null;
    }
}

/**
 * 缓存删除
 */
export async function deleteCache(key: string): Promise<void> {
    const client = getRedis();
    if (!client) {
        return;
    }

    try {
        await client.del(key);
    } catch (err) {
        logger.error({ err, key }, 'Failed to delete cache');
    }
}

export default getRedis;
