import { type FastifyPluginAsync } from 'fastify';
import { authService } from './auth.service.js';
import { loginSchema, changePasswordSchema } from './auth.schema.js';

const authRoutes: FastifyPluginAsync = async (fastify) => {
    // 登录
    fastify.post('/login', async (request, reply) => {
        const input = loginSchema.parse(request.body);
        const result = await authService.login(input, request.ip);

        // 设置 Cookie
        reply.cookie('token', result.token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 7200, // 2 hours (seconds)
        });

        return { success: true, data: result };
    });

    // 登出
    fastify.post('/logout', async (request, reply) => {
        reply.clearCookie('token');
        return { success: true, data: { message: 'Logged out' } };
    });

    // 获取当前用户
    fastify.get('/me', {
        preHandler: [fastify.authenticateJwt],
    }, async (request, _reply) => {
        const admin = await authService.getMe(request.user!.id);
        return { success: true, data: admin };
    });

    // 修改密码
    fastify.post('/change-password', {
        preHandler: [fastify.authenticateJwt],
    }, async (request, _reply) => {
        const input = changePasswordSchema.parse(request.body);
        await authService.changePassword(request.user!.id, input);
        return { success: true, data: { message: 'Password changed' } };
    });
};

export default authRoutes;
