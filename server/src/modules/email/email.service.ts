import { formatExportLine, parseImportLine } from '../../lib/account-import.js';
import prisma from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { AppError } from '../../plugins/error.js';
import type { Prisma } from '@prisma/client';
import type { CreateEmailInput, UpdateEmailInput, ListEmailInput, ImportEmailInput } from './email.schema.js';

export const emailService = {
    /**
     * 获取邮箱列表
     */
    async list(input: ListEmailInput) {
        const { page, pageSize, status, keyword, groupId, groupName } = input;
        const skip = (page - 1) * pageSize;

        const where: Prisma.EmailAccountWhereInput = {};
        if (status) where.status = status;
        if (keyword) {
            where.email = { contains: keyword, mode: 'insensitive' as const };
        }
        if (groupId) {
            where.groupId = groupId;
        } else if (groupName) {
            where.group = { name: groupName };
        }

        const [list, total] = await Promise.all([
            prisma.emailAccount.findMany({
                where,
                select: {
                    id: true,
                    email: true,
                    clientId: true,
                    imapClientId: true,
                status: true,
                groupId: true,
                group: { select: { id: true, name: true, fetchStrategy: true, oauthTenant: true, sendEnabled: true, sendTransport: true } },
                lastCheckAt: true,
                tokenRefreshedAt: true,
                errorMessage: true,
                sendCapability: true,
                smtpCapability: true,
                sendCheckedAt: true,
                lastSentAt: true,
                sendCooldownUntil: true,
                sendErrorMessage: true,
                createdAt: true,
            },
                skip,
                take: pageSize,
                orderBy: { id: 'desc' },
            }),
            prisma.emailAccount.count({ where }),
        ]);

        return { list, total, page, pageSize };
    },

    /**
     * 获取邮箱详情
     */
    async getById(id: number, includeSecrets = false) {
        const email = await prisma.emailAccount.findUnique({
            where: { id },
            select: {
                id: true,
                email: true,
                clientId: true,
                password: !!includeSecrets,
                refreshToken: !!includeSecrets,
                imapClientId: true,
                imapRefreshToken: !!includeSecrets,
                status: true,
                groupId: true,
                group: { select: { id: true, name: true, fetchStrategy: true, oauthTenant: true } },
                lastCheckAt: true,
                tokenRefreshedAt: true,
                errorMessage: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (!email) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        // 解密敏感信息
        if (includeSecrets) {
            return {
                ...email,
                refreshToken: email.refreshToken ? decrypt(email.refreshToken) : email.refreshToken,
                password: email.password ? decrypt(email.password) : email.password,
                imapRefreshToken: email.imapRefreshToken ? decrypt(email.imapRefreshToken) : email.imapRefreshToken,
            };
        }

        return email;
    },

    /**
     * 根据邮箱地址获取（用于外部 API）
     */
    async getByEmail(emailAddress: string) {
        const email = await prisma.emailAccount.findUnique({
            where: { email: emailAddress },
            select: {
                id: true,
                email: true,
                clientId: true,
                refreshToken: true,
                password: true,
                imapClientId: true,
                imapRefreshToken: true,
                status: true,
                groupId: true,
                group: {
                    select: {
                        fetchStrategy: true,
                        oauthTenant: true,
                    },
                },
            },
        });

        if (!email) {
            return null;
        }

        // 解密
        return {
            ...email,
            refreshToken: decrypt(email.refreshToken),
            password: email.password ? decrypt(email.password) : undefined,
            imapRefreshToken: email.imapRefreshToken ? decrypt(email.imapRefreshToken) : null,
            fetchStrategy: email.group?.fetchStrategy || 'GRAPH_FIRST',
            oauthTenant: email.group?.oauthTenant || 'CONSUMERS',
        };
    },

    /**
     * 创建邮箱账户
     */
    async create(input: CreateEmailInput) {
        const { email, clientId, refreshToken, password, groupId, imapClientId, imapRefreshToken } = input;

        const exists = await prisma.emailAccount.findUnique({ where: { email } });
        if (exists) {
            throw new AppError('DUPLICATE_EMAIL', 'Email already exists', 400);
        }

        const encryptedToken = encrypt(refreshToken);
        const encryptedPassword = password ? encrypt(password) : null;

        const account = await prisma.emailAccount.create({
            data: {
                email,
                clientId,
                refreshToken: encryptedToken,
                password: encryptedPassword,
                groupId: groupId || null,
                imapClientId: imapClientId && imapRefreshToken ? imapClientId : null,
                imapRefreshToken: imapClientId && imapRefreshToken ? encrypt(imapRefreshToken) : null,
            },
            select: {
                id: true,
                email: true,
                clientId: true,
                status: true,
                groupId: true,
                createdAt: true,
            },
        });

        return account;
    },

    /**
     * 更新邮箱账户
     */
    async update(id: number, input: UpdateEmailInput) {
        const exists = await prisma.emailAccount.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        const { refreshToken, password, imapClientId, imapRefreshToken, ...rest } = input;
        const updateData: Prisma.EmailAccountUpdateInput = { ...rest };

        // 独立 IMAP 凭据：两项同时传入；都为空表示删除，改用主凭据
        if (imapClientId !== undefined || imapRefreshToken !== undefined) {
            const keep = !!imapClientId && !!imapRefreshToken;
            updateData.imapClientId = keep ? imapClientId : null;
            updateData.imapRefreshToken = keep ? encrypt(imapRefreshToken!) : null;
        }

        // 加密 sensitive data
        if (refreshToken) {
            updateData.refreshToken = encrypt(refreshToken);
        }
        if (password) {
            updateData.password = encrypt(password);
        }

        const account = await prisma.emailAccount.update({
            where: { id },
            data: updateData,
            select: {
                id: true,
                email: true,
                clientId: true,
                status: true,
                updatedAt: true,
            },
        });

        return account;
    },

    /**
     * 更新邮箱状态
     */
    async updateStatus(id: number, status: 'ACTIVE' | 'ERROR' | 'DISABLED', errorMessage?: string | null) {
        await prisma.emailAccount.update({
            where: { id },
            data: {
                status,
                errorMessage: errorMessage || null,
                lastCheckAt: new Date(),
            },
        });
    },

    /**
     * 仅更新时间，不改动邮箱状态
     */
    async touchLastCheckAt(id: number) {
        await prisma.emailAccount.update({
            where: { id },
            data: {
                lastCheckAt: new Date(),
            },
        });
    },

    /**
     * 删除邮箱账户
     */
    async delete(id: number) {
        const exists = await prisma.emailAccount.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        await prisma.emailAccount.delete({ where: { id } });
        return { success: true };
    },

    /**
     * 批量删除
     */
    async batchDelete(ids: number[]) {
        await prisma.emailAccount.deleteMany({
            where: { id: { in: ids } },
        });
        return { deleted: ids.length };
    },

    /**
     * 批量导入
     */
    async import(input: ImportEmailInput) {
        const { content, separator, groupId } = input;
        const lines = content.split('\n').filter((line: string) => line.trim());

        if (groupId !== undefined) {
            const group = await prisma.emailGroup.findUnique({ where: { id: groupId } });
            if (!group) {
                throw new AppError('GROUP_NOT_FOUND', 'Email group not found', 404);
            }
        }

        let success = 0;
        let failed = 0;
        const errors: string[] = [];

        for (const line of lines) {
            try {
                const { email, password, clientId, refreshToken, imapClientId, imapRefreshToken } = parseImportLine(line, separator);
                // 导入的一行即完整凭据：没有独立 IMAP 凭据时清除旧的
                const imapData = {
                    imapClientId: imapClientId ?? null,
                    imapRefreshToken: imapRefreshToken ? encrypt(imapRefreshToken) : null,
                };

                const data: Prisma.EmailAccountUncheckedUpdateInput = {
                    clientId,
                    refreshToken: encrypt(refreshToken),
                    ...imapData,
                    status: 'ACTIVE',
                };
                if (password) data.password = encrypt(password);
                if (groupId !== undefined) data.groupId = groupId;

                // 检查是否存在
                const exists = await prisma.emailAccount.findUnique({ where: { email } });
                if (exists) {
                    // 更新
                    await prisma.emailAccount.update({
                        where: { email },
                        data,
                    });
                } else {
                    // 创建
                    const createData: Prisma.EmailAccountUncheckedCreateInput = {
                        email,
                        clientId,
                        refreshToken: encrypt(refreshToken),
                        ...imapData,
                        status: 'ACTIVE',
                    };
                    if (password) {
                        createData.password = encrypt(password);
                    }
                    if (groupId !== undefined) {
                        createData.groupId = groupId;
                    }
                    await prisma.emailAccount.create({
                        data: createData,
                    });
                }
                success++;
            } catch (err) {
                failed++;
                errors.push(`Line "${line.substring(0, 30)}...": ${(err as Error).message}`);
            }
        }

        return { success, failed, errors };
    },

    /**
     * 导出
     */
    async export(ids?: number[], separator = '----', groupId?: number) {
        const where: Prisma.EmailAccountWhereInput = {};
        if (ids?.length) {
            where.id = { in: ids };
        }
        if (groupId !== undefined) {
            where.groupId = groupId;
        }

        const accounts = await prisma.emailAccount.findMany({
            where,
            select: {
                email: true,
                password: true,
                clientId: true,
                refreshToken: true,
                imapClientId: true,
                imapRefreshToken: true,
            },
        });

        // 有独立 IMAP 凭据的账号导出 6 列（含密码），其它保持 3 列；两种都能直接重新导入
        const lines = accounts.map((acc) => formatExportLine({
            email: acc.email,
            password: acc.imapRefreshToken && acc.password ? decrypt(acc.password) : null,
            clientId: acc.clientId,
            refreshToken: decrypt(acc.refreshToken),
            imapClientId: acc.imapClientId,
            imapRefreshToken: acc.imapRefreshToken ? decrypt(acc.imapRefreshToken) : null,
        }, separator));

        return lines.join('\n');
    },

    /**
     * 获取统计
     */
    async getStats() {
        const [total, active, error] = await Promise.all([
            prisma.emailAccount.count(),
            prisma.emailAccount.count({ where: { status: 'ACTIVE' } }),
            prisma.emailAccount.count({ where: { status: 'ERROR' } }),
        ]);

        return { total, active, error };
    },
};
