import { z } from 'zod';

export const mailFetchStrategySchema = z.enum([
    'GRAPH_FIRST',
    'IMAP_FIRST',
    'GRAPH_ONLY',
    'IMAP_ONLY',
]);

export const sendStrategySchema = z.enum(['LEAST_USED', 'ROUND_ROBIN', 'RANDOM']);

/** 换取令牌使用的微软登录端点：consumers（个人账号）/ organizations（工作或学校账号）/ common（两者） */
export const oauthTenantSchema = z.enum(['CONSUMERS', 'ORGANIZATIONS', 'COMMON']);

/** 发信通道：AUTO 填了发件人名称时走 SMTP（保留名称），否则走 Graph，互为备用；GRAPH / SMTP 只用该通道 */
export const sendTransportSchema = z.enum(['AUTO', 'GRAPH', 'SMTP']);

/**
 * 分组描述：前端编辑没有描述的分组时会传 null，清空输入框时传空字符串；两者都表示“无描述”，存为 null。
 */
const descriptionSchema = z
    .string()
    .max(255)
    .nullish()
    .transform((value) => (typeof value === 'string' ? value.trim() || null : value));

const sendSettingsSchema = {
    sendEnabled: z.boolean(),
    sendStrategy: sendStrategySchema,
    sendDailyLimit: z.number().int().min(1).max(10000),
    sendIntervalSeconds: z.number().int().min(0).max(24 * 60 * 60),
    sendMaxRecipients: z.number().int().min(1).max(150),
    sendTransport: sendTransportSchema,
};

export const createGroupSchema = z.object({
    name: z.string().min(1).max(50),
    description: descriptionSchema,
    fetchStrategy: mailFetchStrategySchema.default('GRAPH_FIRST'),
    oauthTenant: oauthTenantSchema.default('CONSUMERS'),
    sendEnabled: sendSettingsSchema.sendEnabled.optional(),
    sendStrategy: sendSettingsSchema.sendStrategy.optional(),
    sendDailyLimit: sendSettingsSchema.sendDailyLimit.optional(),
    sendIntervalSeconds: sendSettingsSchema.sendIntervalSeconds.optional(),
    sendMaxRecipients: sendSettingsSchema.sendMaxRecipients.optional(),
    sendTransport: sendSettingsSchema.sendTransport.optional(),
});

export const updateGroupSchema = z.object({
    name: z.string().min(1).max(50).optional(),
    description: descriptionSchema,
    fetchStrategy: mailFetchStrategySchema.optional(),
    oauthTenant: oauthTenantSchema.optional(),
    sendEnabled: sendSettingsSchema.sendEnabled.optional(),
    sendStrategy: sendSettingsSchema.sendStrategy.optional(),
    sendDailyLimit: sendSettingsSchema.sendDailyLimit.optional(),
    sendIntervalSeconds: sendSettingsSchema.sendIntervalSeconds.optional(),
    sendMaxRecipients: sendSettingsSchema.sendMaxRecipients.optional(),
    sendTransport: sendSettingsSchema.sendTransport.optional(),
});

export const assignEmailsSchema = z.object({
    emailIds: z.array(z.number().int().positive()),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type AssignEmailsInput = z.infer<typeof assignEmailsSchema>;
export type MailFetchStrategyInput = z.infer<typeof mailFetchStrategySchema>;
