import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_ROUNDS = 10;

/**
 * 生成加密密钥（从环境变量派生）
 */
function getEncryptionKey(): Buffer {
    return createHash('sha256').update(env.ENCRYPTION_KEY).digest();
}

/**
 * AES-256-GCM 加密
 */
export function encrypt(text: string): string {
    const iv = randomBytes(IV_LENGTH);
    const key = getEncryptionKey();
    const cipher = createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // 格式: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * AES-256-GCM 解密
 */
export function decrypt(encryptedText: string): string {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted format');
    }

    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const key = getEncryptionKey();

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

/**
 * 密码哈希
 */
export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * 验证密码
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
}

/**
 * 生成 API Key
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
    const randomPart = randomBytes(24).toString('base64url');
    const key = `sk_${randomPart}`;
    const prefix = key.substring(0, 7);
    const hash = createHash('sha256').update(key).digest('hex');

    return { key, prefix, hash };
}

/**
 * 哈希 API Key（用于验证）
 */
export function hashApiKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
}
