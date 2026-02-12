import { z } from 'zod';
import { isKnownApiPermissionKey } from '../../plugins/api-permissions.js';

const permissionsSchema = z.record(z.boolean()).superRefine((permissions, ctx) => {
    for (const key of Object.keys(permissions)) {
        if (!isKnownApiPermissionKey(key)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [key],
                message: `Unknown permission key: ${key}`,
            });
        }
    }
});

export const createApiKeySchema = z.object({
    name: z.string().min(1).max(100),
    rateLimit: z.number().min(1).max(10000).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    permissions: permissionsSchema.optional(),
    allowedGroupIds: z.array(z.number().int().positive()).optional(),
    allowedEmailIds: z.array(z.number().int().positive()).optional(),
});

export const updateApiKeySchema = z.object({
    name: z.string().min(1).max(100).optional(),
    rateLimit: z.number().min(1).max(10000).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    permissions: permissionsSchema.optional(),
    allowedGroupIds: z.array(z.number().int().positive()).optional(),
    allowedEmailIds: z.array(z.number().int().positive()).optional(),
});

export const listApiKeySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(10),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    keyword: z.string().optional(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type UpdateApiKeyInput = z.infer<typeof updateApiKeySchema>;
export type ListApiKeyInput = z.infer<typeof listApiKeySchema>;
