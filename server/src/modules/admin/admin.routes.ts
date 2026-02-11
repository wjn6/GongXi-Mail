import { type FastifyPluginAsync } from 'fastify';
import { adminService } from './admin.service.js';
import { createAdminSchema, updateAdminSchema, listAdminSchema } from './admin.schema.js';

const adminRoutes: FastifyPluginAsync = async (fastify) => {
    // 所有路由都需要 JWT 认证 + 超级管理员权限
    fastify.addHook('preHandler', fastify.authenticateJwt);
    fastify.addHook('preHandler', fastify.requireSuperAdmin);

    // 列表
    fastify.get('/', async (request) => {
        const input = listAdminSchema.parse(request.query);
        const result = await adminService.list(input);
        return { success: true, data: result };
    });

    // 详情
    fastify.get('/:id', async (request) => {
        const { id } = request.params as { id: string };
        const admin = await adminService.getById(parseInt(id));
        return { success: true, data: admin };
    });

    // 创建
    fastify.post('/', async (request) => {
        const input = createAdminSchema.parse(request.body);
        const admin = await adminService.create(input);
        return { success: true, data: admin };
    });

    // 更新
    fastify.put('/:id', async (request) => {
        const { id } = request.params as { id: string };
        const input = updateAdminSchema.parse(request.body);
        const admin = await adminService.update(parseInt(id), input);
        return { success: true, data: admin };
    });

    // 删除
    fastify.delete('/:id', async (request) => {
        const { id } = request.params as { id: string };
        await adminService.delete(parseInt(id));
        return { success: true, data: { message: 'Admin deleted' } };
    });
};

export default adminRoutes;
