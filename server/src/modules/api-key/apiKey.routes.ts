import { type FastifyPluginAsync } from 'fastify';
import { apiKeyService } from './apiKey.service.js';
import { poolService } from '../mail/pool.service.js';
import { createApiKeySchema, updateApiKeySchema, listApiKeySchema } from './apiKey.schema.js';

const apiKeyRoutes: FastifyPluginAsync = async (fastify) => {
    // 所有路由需要 JWT 认证
    fastify.addHook('preHandler', fastify.authenticateJwt);

    // 列表
    fastify.get('/', async (request) => {
        const input = listApiKeySchema.parse(request.query);
        const result = await apiKeyService.list(input);
        return { success: true, data: result };
    });

    // 创建
    fastify.post('/', async (request) => {
        const input = createApiKeySchema.parse(request.body);
        const apiKey = await apiKeyService.create(input, request.user!.id);
        return { success: true, data: apiKey };
    });

    // 详情
    fastify.get('/:id', async (request) => {
        const { id } = request.params as { id: string };
        const apiKey = await apiKeyService.getById(parseInt(id));
        return { success: true, data: apiKey };
    });

    // 使用统计（调用次数）
    fastify.get('/:id/usage', async (request) => {
        const { id } = request.params as { id: string };
        const { group } = request.query as { group?: string };
        // 获取邮箱池统计
        const poolStats = await poolService.getStats(parseInt(id), group);
        return { success: true, data: poolStats };
    });

    // 重置邮箱池
    fastify.post('/:id/reset-pool', async (request) => {
        const { id } = request.params as { id: string };
        const { group } = request.body as { group?: string };
        await poolService.reset(parseInt(id), group);
        return { success: true, data: { message: '邮箱池已重置' } };
    });

    // 更新
    fastify.put('/:id', async (request) => {
        const { id } = request.params as { id: string };
        const input = updateApiKeySchema.parse(request.body);
        const apiKey = await apiKeyService.update(parseInt(id), input);
        return { success: true, data: apiKey };
    });

    // 删除
    fastify.delete('/:id', async (request) => {
        const { id } = request.params as { id: string };
        await apiKeyService.delete(parseInt(id));
        return { success: true, data: { message: 'API Key deleted' } };
    });

    // 获取邮箱列表及使用状态
    fastify.get('/:id/pool-emails', async (request) => {
        const { id } = request.params as { id: string };
        const { groupId } = request.query as { groupId?: string };
        const emails = await poolService.getEmailsWithUsage(parseInt(id), groupId ? parseInt(groupId) : undefined);
        return { success: true, data: emails };
    });

    // 更新邮箱使用状态
    fastify.put('/:id/pool-emails', async (request) => {
        const { id } = request.params as { id: string };
        const { emailIds } = request.body as { emailIds: number[] };
        const result = await poolService.updateEmailUsage(parseInt(id), emailIds || []);
        return { success: true, data: result };
    });
};

export default apiKeyRoutes;

