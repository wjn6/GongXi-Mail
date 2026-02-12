import { z } from 'zod';

export const createAdminSchema = z.object({
    username: z.string().min(3).max(50),
    password: z.string().min(6),
    email: z.string().email().optional(),
    role: z.enum(['SUPER_ADMIN', 'ADMIN']).optional(),
});

export const updateAdminSchema = z.object({
    username: z.string().min(3).max(50).optional(),
    password: z.string().min(6).optional(),
    email: z.string().email().nullable().optional(),
    role: z.enum(['SUPER_ADMIN', 'ADMIN']).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    twoFactorEnabled: z.boolean().optional(),
});

export const listAdminSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(10),
    keyword: z.string().optional(),
});

export type CreateAdminInput = z.infer<typeof createAdminSchema>;
export type UpdateAdminInput = z.infer<typeof updateAdminSchema>;
export type ListAdminInput = z.infer<typeof listAdminSchema>;
