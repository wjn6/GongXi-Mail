/**
 * Resend 兼容接口的 Idempotency-Key：同一 Key 24 小时内只处理一次。
 * - 相同 Key + 相同请求体：返回首次的响应
 * - 相同 Key + 不同请求体：409 invalid_idempotent_request
 * - 首次请求仍在处理中：409 concurrent_idempotent_requests
 * 只保存成功响应；失败时释放 Key，允许客户端用同一 Key 重试。
 */
import prisma from '../../lib/prisma.js';
import { IDEMPOTENCY_TTL_MS } from '../../lib/send-mail.js';
import { ResendApiError } from '../../lib/resend-compat.js';
import type { Prisma } from '@prisma/client';

function hasErrorCode(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && (error as { code?: unknown }).code === code;
}

export type IdempotencyBegin =
    | { kind: 'new'; recordId: number }
    | { kind: 'replay'; status: number; body: unknown };

export async function beginIdempotentRequest(
    apiKeyId: number,
    endpoint: string,
    key: string,
    requestHash: string
): Promise<IdempotencyBegin> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const record = await prisma.resendIdempotency.create({
                data: {
                    apiKeyId,
                    endpoint,
                    key,
                    requestHash,
                    status: 'PROCESSING',
                    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
                },
                select: { id: true },
            });
            return { kind: 'new', recordId: record.id };
        } catch (err) {
            if (!hasErrorCode(err, 'P2002')) {
                throw err;
            }
        }

        const existing = await prisma.resendIdempotency.findUnique({
            where: { apiKeyId_endpoint_key: { apiKeyId, endpoint, key } },
        });
        if (!existing) {
            continue;
        }
        if (existing.expiresAt.getTime() <= Date.now()) {
            await prisma.resendIdempotency.deleteMany({ where: { id: existing.id } });
            continue;
        }
        if (existing.requestHash !== requestHash) {
            throw new ResendApiError(
                409,
                'invalid_idempotent_request',
                'This idempotency key has been used on a request with a different payload. Use a new idempotency key or send the same payload.'
            );
        }
        if (existing.status === 'PROCESSING') {
            throw new ResendApiError(
                409,
                'concurrent_idempotent_requests',
                'Another request with the same idempotency key is still in progress. Try again later.'
            );
        }
        return { kind: 'replay', status: existing.responseStatus ?? 200, body: existing.responseBody };
    }
    throw new ResendApiError(409, 'concurrent_idempotent_requests', 'Another request with the same idempotency key is still in progress. Try again later.');
}

export async function completeIdempotentRequest(recordId: number, status: number, body: unknown) {
    await prisma.resendIdempotency.update({
        where: { id: recordId },
        data: { status: 'COMPLETED', responseStatus: status, responseBody: body as Prisma.InputJsonValue },
    });
}

export async function releaseIdempotentRequest(recordId: number) {
    await prisma.resendIdempotency.deleteMany({ where: { id: recordId, status: 'PROCESSING' } });
}

export async function cleanupExpiredIdempotency(): Promise<number> {
    const result = await prisma.resendIdempotency.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    return result.count;
}
