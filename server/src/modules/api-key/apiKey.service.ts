import prisma from '../../lib/prisma.js';
import { generateApiKey } from '../../lib/crypto.js';
import { AppError } from '../../plugins/error.js';
import type { Prisma } from '@prisma/client';
import type { CreateApiKeyInput, UpdateApiKeyInput, ListApiKeyInput } from './apiKey.schema.js';

export const apiKeyService = {
    /**
     * 获取 API Key 列表
     */
    async list(input: ListApiKeyInput) {
        const { page, pageSize, status, keyword } = input;
        const skip = (page - 1) * pageSize;

        const where: Prisma.ApiKeyWhereInput = {};
        if (status) where.status = status;
        if (keyword) {
            where.OR = [
                { name: { contains: keyword } },
                { keyPrefix: { contains: keyword } },
            ];
        }

        const [list, total] = await Promise.all([
            prisma.apiKey.findMany({
                where,
                select: {
                    id: true,
                    name: true,
                    keyPrefix: true,
                    rateLimit: true,
                    status: true,
                    expiresAt: true,
                    lastUsedAt: true,
                    usageCount: true,
                    createdAt: true,
                    creator: {
                        select: { username: true },
                    },
                },
                skip,
                take: pageSize,
                orderBy: { id: 'desc' },
            }),
            prisma.apiKey.count({ where }),
        ]);

        // 转换 BigInt
        const formattedList = list.map((item: typeof list[number]) => ({
            ...item,
            usageCount: Number(item.usageCount),
            createdByName: item.creator?.username,
        }));

        return { list: formattedList, total, page, pageSize };
    },

    /**
     * 创建 API Key
     */
    async create(input: CreateApiKeyInput, createdBy: number) {
        const { name, rateLimit, expiresAt, permissions } = input;

        // 生成 API Key
        const { key, prefix, hash } = generateApiKey();

        const apiKey = await prisma.apiKey.create({
            data: {
                name,
                keyHash: hash,
                keyPrefix: prefix,
                rateLimit: rateLimit || 60,
                expiresAt: expiresAt ? new Date(expiresAt) : null,
                permissions: permissions ? permissions : undefined,
                createdBy,
            },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                rateLimit: true,
                status: true,
                expiresAt: true,
                createdAt: true,
            },
        });

        // 返回完整 key（只在创建时返回）
        return { ...apiKey, key };
    },

    /**
     * 获取 API Key 详情
     */
    async getById(id: number) {
        const apiKey = await prisma.apiKey.findUnique({
            where: { id },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                rateLimit: true,
                status: true,
                expiresAt: true,
                lastUsedAt: true,
                usageCount: true,
                permissions: true,
                createdAt: true,
                updatedAt: true,
                creator: {
                    select: { username: true },
                },
            },
        });

        if (!apiKey) {
            throw new AppError('NOT_FOUND', 'API Key not found', 404);
        }

        return {
            ...apiKey,
            usageCount: Number(apiKey.usageCount),
            createdByName: apiKey.creator?.username,
        };
    },

    /**
     * 更新 API Key
     */
    async update(id: number, input: UpdateApiKeyInput) {
        const exists = await prisma.apiKey.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'API Key not found', 404);
        }

        const { expiresAt, ...rest } = input;
        const updateData: Prisma.ApiKeyUpdateInput = { ...rest };
        if (expiresAt) {
            updateData.expiresAt = new Date(expiresAt);
        }

        const apiKey = await prisma.apiKey.update({
            where: { id },
            data: updateData,
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                rateLimit: true,
                status: true,
                expiresAt: true,
                updatedAt: true,
            },
        });

        return apiKey;
    },

    /**
     * 删除 API Key
     */
    async delete(id: number) {
        const exists = await prisma.apiKey.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'API Key not found', 404);
        }

        await prisma.apiKey.delete({ where: { id } });
        return { success: true };
    },

    /**
     * 获取 API Key 使用统计
     */
    async getUsageStats(id: number) {
        const apiKey = await prisma.apiKey.findUnique({
            where: { id },
            select: {
                usageCount: true,
                lastUsedAt: true,
                createdAt: true,
            },
        });

        if (!apiKey) {
            throw new AppError('NOT_FOUND', 'API Key not found', 404);
        }

        const daysSinceCreation = Math.ceil(
            (Date.now() - new Date(apiKey.createdAt).getTime()) / (1000 * 60 * 60 * 24)
        );
        const avgPerDay = daysSinceCreation > 0
            ? Math.round(Number(apiKey.usageCount) / daysSinceCreation)
            : Number(apiKey.usageCount);

        return {
            totalUsage: Number(apiKey.usageCount),
            lastUsedAt: apiKey.lastUsedAt,
            avgPerDay,
        };
    },
};
