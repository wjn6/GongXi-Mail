import { type FastifyPluginAsync } from 'fastify';
import { emailService } from './email.service.js';
import { mailService } from '../mail/mail.service.js';
import { createEmailSchema, updateEmailSchema, listEmailSchema, importEmailSchema } from './email.schema.js';
import { z } from 'zod';

const emailRoutes: FastifyPluginAsync = async (fastify) => {
    // 所有路由需要 JWT 认证
    fastify.addHook('preHandler', fastify.authenticateJwt);

    // 列表
    fastify.get('/', async (request) => {
        const input = listEmailSchema.parse(request.query);
        const result = await emailService.list(input);
        return { success: true, data: result };
    });

    // 详情
    fastify.get('/:id', async (request) => {
        const { id } = request.params as { id: string };
        const { secrets } = request.query as { secrets?: string };
        const email = await emailService.getById(parseInt(id), secrets === 'true');
        return { success: true, data: email };
    });

    // 创建
    fastify.post('/', async (request) => {
        const input = createEmailSchema.parse(request.body);
        const email = await emailService.create(input);
        return { success: true, data: email };
    });

    // 更新
    fastify.put('/:id', async (request) => {
        const { id } = request.params as { id: string };
        const input = updateEmailSchema.parse(request.body);
        const email = await emailService.update(parseInt(id), input);
        return { success: true, data: email };
    });

    // 删除
    fastify.delete('/:id', async (request) => {
        const { id } = request.params as { id: string };
        await emailService.delete(parseInt(id));
        return { success: true, data: { message: 'Email account deleted' } };
    });

    // 批量删除
    fastify.post('/batch-delete', async (request) => {
        const { ids } = z.object({ ids: z.array(z.number()) }).parse(request.body);
        const result = await emailService.batchDelete(ids);
        return { success: true, data: result };
    });

    // 批量导入
    fastify.post('/import', async (request) => {
        const input = importEmailSchema.parse(request.body);
        const result = await emailService.import(input);
        return { success: true, data: result };
    });

    // 导出
    fastify.get('/export', async (request) => {
        const { ids, separator } = request.query as { ids?: string; separator?: string };
        const idArray = ids?.split(',').map(Number).filter(Boolean);
        const content = await emailService.export(idArray, separator);
        return { success: true, data: { content } };
    });

    // 查看邮件 (管理员专用)
    fastify.get('/:id/mails', async (request) => {
        const { id } = request.params as { id: string };
        const { mailbox } = request.query as { mailbox?: string };

        const emailData = await emailService.getById(parseInt(id), true);

        const credentials = {
            id: emailData.id,
            email: emailData.email,
            clientId: emailData.clientId,
            refreshToken: emailData.refreshToken!,
            autoAssigned: false,
        };

        const mails = await mailService.getEmails(credentials, { mailbox: mailbox || 'INBOX' });
        return { success: true, data: mails };
    });

    // 清空邮箱 (管理员专用)
    fastify.post('/:id/clear', async (request) => {
        const { id } = request.params as { id: string };
        const { mailbox } = request.body as { mailbox?: string };

        const emailData = await emailService.getById(parseInt(id), true);

        const credentials = {
            id: emailData.id,
            email: emailData.email,
            clientId: emailData.clientId,
            refreshToken: emailData.refreshToken!,
            autoAssigned: false,
        };

        const result = await mailService.processMailbox(credentials, { mailbox: mailbox || 'INBOX' });
        return { success: true, data: result };
    });
};

export default emailRoutes;

