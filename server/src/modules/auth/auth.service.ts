import prisma from '../../lib/prisma.js';
import { signToken } from '../../lib/jwt.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { getRedis } from '../../lib/redis.js';
import { AppError } from '../../plugins/error.js';
import type { LoginInput, ChangePasswordInput } from './auth.schema.js';
import { createHmac } from 'node:crypto';

interface LocalLoginAttemptState {
    count: number;
    resetAt: number;
    lockedUntil: number;
}

const localLoginAttemptStore = new Map<string, LocalLoginAttemptState>();

function buildLoginAttemptCacheKey(username: string, ip?: string): string {
    const normalizedUsername = username.trim().toLowerCase();
    const normalizedIp = ip?.trim() || 'unknown';
    return `admin-login:${normalizedUsername}:${normalizedIp}`;
}

function buildRedisLoginAttemptKey(cacheKey: string): string {
    return `auth:admin:login:attempt:${cacheKey}`;
}

function buildRedisLoginLockKey(cacheKey: string): string {
    return `auth:admin:login:lock:${cacheKey}`;
}

const LOCK_SECONDS = env.ADMIN_LOGIN_LOCK_MINUTES * 60;
const ATTEMPT_WINDOW_SECONDS = LOCK_SECONDS;

function formatLockMessage(lockSeconds: number): string {
    const minutes = Math.max(1, Math.ceil(lockSeconds / 60));
    return `Too many failed attempts. Please try again in ${minutes} minute(s)`;
}

async function getLockRemainingSeconds(cacheKey: string): Promise<number> {
    const redis = getRedis();
    if (redis) {
        try {
            const ttl = await redis.ttl(buildRedisLoginLockKey(cacheKey));
            if (ttl > 0) {
                return ttl;
            }
        } catch {
            // Redis 异常时回退本地存储
        }
    }

    const state = localLoginAttemptStore.get(cacheKey);
    if (!state) {
        return 0;
    }

    const now = Date.now();
    if (state.lockedUntil > now) {
        return Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
    }

    if (state.resetAt <= now) {
        localLoginAttemptStore.delete(cacheKey);
    } else {
        state.lockedUntil = 0;
    }

    return 0;
}

async function clearLoginAttempts(cacheKey: string): Promise<void> {
    const redis = getRedis();
    if (redis) {
        try {
            await redis.del(buildRedisLoginAttemptKey(cacheKey), buildRedisLoginLockKey(cacheKey));
        } catch {
            // Redis 异常时继续清理本地存储
        }
    }

    localLoginAttemptStore.delete(cacheKey);
}

async function recordLoginFailure(cacheKey: string): Promise<number> {
    const redis = getRedis();
    if (redis) {
        try {
            const attemptKey = buildRedisLoginAttemptKey(cacheKey);
            const lockKey = buildRedisLoginLockKey(cacheKey);
            const count = await redis.incr(attemptKey);
            if (count === 1) {
                await redis.expire(attemptKey, ATTEMPT_WINDOW_SECONDS);
            }

            if (count >= env.ADMIN_LOGIN_MAX_ATTEMPTS) {
                await redis.set(lockKey, '1', 'EX', LOCK_SECONDS);
                await redis.del(attemptKey);
                return LOCK_SECONDS;
            }
            return 0;
        } catch {
            // Redis 异常时回退本地存储
        }
    }

    const now = Date.now();
    const state = localLoginAttemptStore.get(cacheKey);
    if (!state || state.resetAt <= now) {
        localLoginAttemptStore.set(cacheKey, {
            count: 1,
            resetAt: now + ATTEMPT_WINDOW_SECONDS * 1000,
            lockedUntil: 0,
        });
        return 0;
    }

    if (state.lockedUntil > now) {
        return Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
    }

    state.count += 1;
    if (state.count >= env.ADMIN_LOGIN_MAX_ATTEMPTS) {
        state.count = 0;
        state.lockedUntil = now + LOCK_SECONDS * 1000;
        return LOCK_SECONDS;
    }

    localLoginAttemptStore.set(cacheKey, state);
    return 0;
}

function decodeBase32(secret: string): Buffer {
    const normalized = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
    if (!normalized) {
        throw new Error('Invalid base32 secret');
    }

    let bits = '';
    for (const char of normalized) {
        const value = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
        if (value < 0) {
            throw new Error('Invalid base32 character');
        }
        bits += value.toString(2).padStart(5, '0');
    }

    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

function generateTotpCode(secret: Buffer, step: number): string {
    const counter = Buffer.alloc(8);
    const high = Math.floor(step / 0x100000000);
    const low = step >>> 0;
    counter.writeUInt32BE(high, 0);
    counter.writeUInt32BE(low, 4);

    const digest = createHmac('sha1', secret).update(counter).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
        ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    const code = binary % 1_000_000;
    return code.toString().padStart(6, '0');
}

function verifyTotpCode(token: string | undefined): boolean {
    if (!env.ADMIN_2FA_SECRET) {
        return true;
    }

    if (!token || !/^\d{6}$/.test(token)) {
        return false;
    }

    const secret = decodeBase32(env.ADMIN_2FA_SECRET);
    const currentStep = Math.floor(Date.now() / 1000 / 30);
    const window = env.ADMIN_2FA_WINDOW;
    for (let offset = -window; offset <= window; offset += 1) {
        if (generateTotpCode(secret, currentStep + offset) === token) {
            return true;
        }
    }

    return false;
}

export const authService = {
    /**
     * 管理员登录
     */
    async login(input: LoginInput, ip?: string) {
        const { username, password, otp } = input;
        const loginAttemptCacheKey = buildLoginAttemptCacheKey(username, ip);
        const lockSeconds = await getLockRemainingSeconds(loginAttemptCacheKey);
        if (lockSeconds > 0) {
            throw new AppError('ACCOUNT_LOCKED', formatLockMessage(lockSeconds), 429);
        }

        // 查询管理员
        const admin = await prisma.admin.findUnique({
            where: { username },
            select: {
                id: true,
                username: true,
                passwordHash: true,
                role: true,
                status: true,
            },
        });

        // 管理员不存在，检查是否是默认管理员
        if (!admin) {
            if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) {
                if (!verifyTotpCode(otp)) {
                    const newLockSeconds = await recordLoginFailure(loginAttemptCacheKey);
                    if (newLockSeconds > 0) {
                        throw new AppError('ACCOUNT_LOCKED', formatLockMessage(newLockSeconds), 429);
                    }
                    throw new AppError('INVALID_OTP', 'Invalid two-factor code', 401);
                }

                // 如果是默认管理员但数据库不存在，自动创建
                const passwordHash = await hashPassword(password);
                const newAdmin = await prisma.admin.create({
                    data: {
                        username,
                        passwordHash,
                        role: 'SUPER_ADMIN',
                        status: 'ACTIVE',
                    },
                });

                await clearLoginAttempts(loginAttemptCacheKey);

                // 使用新创建的管理员信息生成 Token
                const token = await signToken({
                    sub: newAdmin.id.toString(),
                    username: newAdmin.username,
                    role: newAdmin.role,
                });

                return {
                    token,
                    admin: {
                        id: newAdmin.id,
                        username: newAdmin.username,
                        role: newAdmin.role,
                    },
                };
            }

            const newLockSeconds = await recordLoginFailure(loginAttemptCacheKey);
            if (newLockSeconds > 0) {
                throw new AppError('ACCOUNT_LOCKED', formatLockMessage(newLockSeconds), 429);
            }
            throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password', 401);
        }

        // 检查状态
        if (admin.status !== 'ACTIVE') {
            throw new AppError('ACCOUNT_DISABLED', 'Account is disabled', 403);
        }

        // 验证密码
        const isValid = await verifyPassword(password, admin.passwordHash);
        if (!isValid) {
            const newLockSeconds = await recordLoginFailure(loginAttemptCacheKey);
            if (newLockSeconds > 0) {
                throw new AppError('ACCOUNT_LOCKED', formatLockMessage(newLockSeconds), 429);
            }
            throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password', 401);
        }

        // 可选 2FA
        if (!verifyTotpCode(otp)) {
            const newLockSeconds = await recordLoginFailure(loginAttemptCacheKey);
            if (newLockSeconds > 0) {
                throw new AppError('ACCOUNT_LOCKED', formatLockMessage(newLockSeconds), 429);
            }
            throw new AppError('INVALID_OTP', 'Invalid two-factor code', 401);
        }

        await clearLoginAttempts(loginAttemptCacheKey);

        // 更新登录信息
        await prisma.admin.update({
            where: { id: admin.id },
            data: {
                lastLoginAt: new Date(),
                lastLoginIp: ip,
            },
        });

        // 生成 Token
        const token = await signToken({
            sub: admin.id.toString(),
            username: admin.username,
            role: admin.role,
        });

        return {
            token,
            admin: {
                id: admin.id,
                username: admin.username,
                role: admin.role,
            },
        };
    },

    /**
     * 修改密码
     */
    async changePassword(adminId: number, input: ChangePasswordInput) {
        const { oldPassword, newPassword } = input;

        // 环境变量管理员（id=0）不能修改密码
        if (adminId === 0) {
            throw new AppError('CANNOT_CHANGE', 'Cannot change password for default admin', 400);
        }

        const admin = await prisma.admin.findUnique({
            where: { id: adminId },
            select: { passwordHash: true },
        });

        if (!admin) {
            throw new AppError('NOT_FOUND', 'Admin not found', 404);
        }

        const isValid = await verifyPassword(oldPassword, admin.passwordHash);
        if (!isValid) {
            throw new AppError('INVALID_PASSWORD', 'Invalid old password', 400);
        }

        const newHash = await hashPassword(newPassword);
        await prisma.admin.update({
            where: { id: adminId },
            data: { passwordHash: newHash },
        });

        return { success: true };
    },

    /**
     * 获取当前管理员信息
     */
    async getMe(adminId: number) {
        if (adminId === 0) {
            return {
                id: 0,
                username: env.ADMIN_USERNAME,
                role: 'SUPER_ADMIN',
            };
        }

        const admin = await prisma.admin.findUnique({
            where: { id: adminId },
            select: {
                id: true,
                username: true,
                email: true,
                role: true,
                lastLoginAt: true,
                createdAt: true,
            },
        });

        if (!admin) {
            throw new AppError('NOT_FOUND', 'Admin not found', 404);
        }

        return admin;
    },
};
