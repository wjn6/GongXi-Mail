import { z } from 'zod';

/** 独立 IMAP 凭据：空字符串 / null 表示不使用（IMAP 也用主凭据） */
const optionalSecret = (max: number) => z
    .string()
    .max(max)
    .nullish()
    .transform((value) => (typeof value === 'string' ? value.trim() || null : value));

const imapCredentialFields = {
    imapClientId: optionalSecret(100),
    imapRefreshToken: optionalSecret(20000),
};

function imapPairRefine(value: { imapClientId?: string | null; imapRefreshToken?: string | null }, ctx: z.RefinementCtx) {
    if (value.imapClientId === undefined && value.imapRefreshToken === undefined) return;
    if (!!value.imapClientId !== !!value.imapRefreshToken) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [value.imapClientId ? 'imapRefreshToken' : 'imapClientId'],
            message: 'IMAP client ID and IMAP refresh token must be provided together',
        });
    }
}

export const createEmailSchema = z.object({
    email: z.string().email(),
    clientId: z.string().min(1),
    refreshToken: z.string().min(1),
    password: z.string().optional(),
    groupId: z.coerce.number().int().positive().optional(),
    ...imapCredentialFields,
}).superRefine(imapPairRefine);

export const updateEmailSchema = z.object({
    email: z.string().email().optional(),
    clientId: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    password: z.string().optional(),
    status: z.enum(['ACTIVE', 'ERROR', 'DISABLED']).optional(),
    groupId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
    ...imapCredentialFields,
}).superRefine(imapPairRefine);

export const listEmailSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(10),
    status: z.enum(['ACTIVE', 'ERROR', 'DISABLED']).optional(),
    keyword: z.string().optional(),
    groupId: z.coerce.number().int().positive().optional(),
    groupName: z.string().optional(),
});

export const importEmailSchema = z.object({
    content: z.string().min(1),
    separator: z.string().default('----'),
    groupId: z.coerce.number().int().positive().optional(),
});

export type CreateEmailInput = z.infer<typeof createEmailSchema>;
export type UpdateEmailInput = z.infer<typeof updateEmailSchema>;
export type ListEmailInput = z.infer<typeof listEmailSchema>;
export type ImportEmailInput = z.infer<typeof importEmailSchema>;
