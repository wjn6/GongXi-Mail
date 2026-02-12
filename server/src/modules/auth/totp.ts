import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret: string): Buffer {
    const normalized = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
    if (!normalized) {
        throw new Error('Invalid base32 secret');
    }

    let bits = '';
    for (const char of normalized) {
        const value = BASE32_ALPHABET.indexOf(char);
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

function encodeBase32(buffer: Buffer): string {
    let bits = '';
    for (const byte of buffer) {
        bits += byte.toString(2).padStart(8, '0');
    }

    let output = '';
    for (let i = 0; i < bits.length; i += 5) {
        const chunk = bits.slice(i, i + 5);
        if (chunk.length < 5) {
            output += BASE32_ALPHABET[parseInt(chunk.padEnd(5, '0'), 2)];
        } else {
            output += BASE32_ALPHABET[parseInt(chunk, 2)];
        }
    }

    return output;
}

function generateHotpCode(secret: Buffer, step: number): string {
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

    return (binary % 1_000_000).toString().padStart(6, '0');
}

export function generateBase32Secret(byteLength: number = 20): string {
    return encodeBase32(randomBytes(Math.max(10, byteLength)));
}

export function generateTotpCodeAt(secretBase32: string, timestampMs: number): string {
    const secret = decodeBase32(secretBase32);
    const currentStep = Math.floor(timestampMs / 1000 / 30);
    return generateHotpCode(secret, currentStep);
}

export function verifyTotpCode(
    secretBase32: string,
    token: string | undefined,
    window: number = 1,
    timestampMs: number = Date.now()
): boolean {
    if (!token || !/^\d{6}$/.test(token)) {
        return false;
    }

    const secret = decodeBase32(secretBase32);
    const currentStep = Math.floor(timestampMs / 1000 / 30);
    const safeWindow = Math.max(0, Math.min(window, 5));

    for (let offset = -safeWindow; offset <= safeWindow; offset += 1) {
        if (generateHotpCode(secret, currentStep + offset) === token) {
            return true;
        }
    }

    return false;
}

export function buildTotpUri(secretBase32: string, accountName: string, issuer: string): string {
    const normalizedIssuer = issuer.trim() || 'GongXi Mail';
    const normalizedAccount = accountName.trim() || 'admin';
    return `otpauth://totp/${encodeURIComponent(`${normalizedIssuer}:${normalizedAccount}`)}?secret=${encodeURIComponent(secretBase32)}&issuer=${encodeURIComponent(normalizedIssuer)}&algorithm=SHA1&digits=6&period=30`;
}
