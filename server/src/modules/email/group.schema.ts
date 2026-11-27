import { z } from 'zod';

export const mailFetchStrategySchema = z.enum([
    'GRAPH_FIRST',
    'IMAP_FIRST',
    'GRAPH_ONLY',
    'IMAP_ONLY',
]);

export const sendStrategySchema = z.enum(['LEAST_USED', 'ROUND_ROBIN', 'RANDOM']);

const sendSettingsSchema = {
    sendEnabled: z.boolean(),
    sendStrategy: sendStrategySchema,
    sendDailyLimit: z.number().int().min(1).max(10000),
    sendIntervalSeconds: z.number().int().min(0).max(24 * 60 * 60),
    sendMaxRecipients: z.number().int().min(1).max(150),
};

export const createGroupSchema = z.object({
    name: z.string().min(1).max(50),
    description: z.string().max(255).optional(),
    fetchStrategy: mailFetchStrategySchema.default('GRAPH_FIRST'),
    sendEnabled: sendSettingsSchema.sendEnabled.optional(),
    sendStrategy: sendSettingsSchema.sendStrategy.optional(),
    sendDailyLimit: sendSettingsSchema.sendDailyLimit.optional(),
    sendIntervalSeconds: sendSettingsSchema.sendIntervalSeconds.optional(),
    sendMaxRecipients: sendSettingsSchema.sendMaxRecipients.optional(),
});

export const updateGroupSchema = z.object({
    name: z.string().min(1).max(50).optional(),
    description: z.string().max(255).optional(),
    fetchStrategy: mailFetchStrategySchema.optional(),
    sendEnabled: sendSettingsSchema.sendEnabled.optional(),
    sendStrategy: sendSettingsSchema.sendStrategy.optional(),
    sendDailyLimit: sendSettingsSchema.sendDailyLimit.optional(),
    sendIntervalSeconds: sendSettingsSchema.sendIntervalSeconds.optional(),
    sendMaxRecipients: sendSettingsSchema.sendMaxRecipients.optional(),
});

export const assignEmailsSchema = z.object({
    emailIds: z.array(z.number().int().positive()),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type AssignEmailsInput = z.infer<typeof assignEmailsSchema>;
export type MailFetchStrategyInput = z.infer<typeof mailFetchStrategySchema>;
