import { z } from 'zod';

export const mailFetchStrategySchema = z.enum([
    'GRAPH_FIRST',
    'IMAP_FIRST',
    'GRAPH_ONLY',
    'IMAP_ONLY',
]);

export const createGroupSchema = z.object({
    name: z.string().min(1).max(50),
    description: z.string().max(255).optional(),
    fetchStrategy: mailFetchStrategySchema.default('GRAPH_FIRST'),
});

export const updateGroupSchema = z.object({
    name: z.string().min(1).max(50).optional(),
    description: z.string().max(255).optional(),
    fetchStrategy: mailFetchStrategySchema.optional(),
});

export const assignEmailsSchema = z.object({
    emailIds: z.array(z.number().int().positive()),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type AssignEmailsInput = z.infer<typeof assignEmailsSchema>;
export type MailFetchStrategyInput = z.infer<typeof mailFetchStrategySchema>;
