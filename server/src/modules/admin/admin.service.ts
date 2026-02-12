import prisma from '../../lib/prisma.js';
import { hashPassword } from '../../lib/crypto.js';
import { AppError } from '../../plugins/error.js';
import type { Prisma } from '@prisma/client';
import type { CreateAdminInput, UpdateAdminInput, ListAdminInput } from './admin.schema.js';

export const adminService = {
    /**
     * 获取管理员列表
     */
    async list(input: ListAdminInput) {
        const { page, pageSize, keyword } = input;
        const skip = (page - 1) * pageSize;

        const where = keyword
            ? {
                OR: [
                    { username: { contains: keyword } },
                    { email: { contains: keyword } },
                ],
            }
            : {};

        const [list, total] = await Promise.all([
            prisma.admin.findMany({
                where,
                select: {
                    id: true,
                    username: true,
                    email: true,
                    role: true,
                    status: true,
                    twoFactorEnabled: true,
                    lastLoginAt: true,
                    createdAt: true,
                },
                skip,
                take: pageSize,
                orderBy: { id: 'desc' },
            }),
            prisma.admin.count({ where }),
        ]);

        return { list, total, page, pageSize };
    },

    /**
     * 获取管理员详情
     */
    async getById(id: number) {
        const admin = await prisma.admin.findUnique({
            where: { id },
            select: {
                id: true,
                username: true,
                email: true,
                role: true,
                status: true,
                twoFactorEnabled: true,
                lastLoginAt: true,
                lastLoginIp: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (!admin) {
            throw new AppError('NOT_FOUND', 'Admin not found', 404);
        }

        return admin;
    },

    /**
     * 创建管理员
     */
    async create(input: CreateAdminInput) {
        const { username, password, email, role } = input;

        // 检查用户名是否存在
        const exists = await prisma.admin.findUnique({ where: { username } });
        if (exists) {
            throw new AppError('DUPLICATE_USERNAME', 'Username already exists', 400);
        }

        const passwordHash = await hashPassword(password);

        const admin = await prisma.admin.create({
            data: {
                username,
                passwordHash,
                email,
                role: role || 'ADMIN',
            },
            select: {
                id: true,
                username: true,
                email: true,
                role: true,
                status: true,
                twoFactorEnabled: true,
                createdAt: true,
            },
        });

        return admin;
    },

    /**
     * 更新管理员
     */
    async update(id: number, input: UpdateAdminInput) {
        const admin = await prisma.admin.findUnique({ where: { id } });
        if (!admin) {
            throw new AppError('NOT_FOUND', 'Admin not found', 404);
        }

        const { password, twoFactorEnabled, ...rest } = input;
        const updateData: Prisma.AdminUpdateInput = { ...rest };

        if (password) {
            updateData.passwordHash = await hashPassword(password);
        }

        if (twoFactorEnabled !== undefined) {
            if (twoFactorEnabled && !admin.twoFactorEnabled) {
                throw new AppError('INVALID_2FA_UPDATE', 'Cannot enable 2FA without owner setup', 400);
            }

            updateData.twoFactorEnabled = twoFactorEnabled;
            if (!twoFactorEnabled) {
                updateData.twoFactorSecret = null;
                updateData.twoFactorTempSecret = null;
            }
        }

        const updated = await prisma.admin.update({
            where: { id },
            data: updateData,
            select: {
                id: true,
                username: true,
                email: true,
                role: true,
                status: true,
                twoFactorEnabled: true,
                updatedAt: true,
            },
        });

        return updated;
    },

    /**
     * 删除管理员
     */
    async delete(id: number) {
        const admin = await prisma.admin.findUnique({ where: { id } });
        if (!admin) {
            throw new AppError('NOT_FOUND', 'Admin not found', 404);
        }

        await prisma.admin.delete({ where: { id } });
        return { success: true };
    },
};
