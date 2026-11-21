import { type FastifyPluginAsync } from 'fastify';
import { authService } from './auth.service.js';
import { loginSchema, changePasswordSchema, verify2FaSchema, disable2FaSchema } from './auth.schema.js';
import { jwtExpiresInSeconds } from '../../config/env.js';

const authRoutes: FastifyPluginAsync = async (fastify) => {
    // 登录（按 IP 限流，防暴力破解；账号级锁定见 auth.service）
    fastify.post('/login', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const input = loginSchema.parse(request.body);
        const result = await authService.login(input, request.ip);

        // 设置 Cookie（与 JWT_EXPIRES_IN 保持一致，maxAge 单位为秒）
        reply.cookie('token', result.token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: jwtExpiresInSeconds(),
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
        request.log.info({
            systemEvent: true,
            action: 'auth.change_password',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
        }, '修改管理员密码');
        return { success: true, data: { message: 'Password changed' } };
    });

    // 2FA 状态
    fastify.get('/2fa/status', {
        preHandler: [fastify.authenticateJwt],
    }, async (request) => {
        const result = await authService.getTwoFactorStatus(request.user!.id);
        return { success: true, data: result };
    });

    // 生成 2FA 绑定信息
    fastify.post('/2fa/setup', {
        preHandler: [fastify.authenticateJwt],
    }, async (request) => {
        const result = await authService.setupTwoFactor(request.user!.id);
        return { success: true, data: result };
    });

    // 启用 2FA
    fastify.post('/2fa/enable', {
        preHandler: [fastify.authenticateJwt],
    }, async (request) => {
        const input = verify2FaSchema.parse(request.body);
        const result = await authService.enableTwoFactor(request.user!.id, input);
        request.log.info({
            systemEvent: true,
            action: 'auth.2fa_enable',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
        }, '启用管理员二次验证');
        return { success: true, data: result };
    });

    // 禁用 2FA
    fastify.post('/2fa/disable', {
        preHandler: [fastify.authenticateJwt],
    }, async (request) => {
        const input = disable2FaSchema.parse(request.body);
        const result = await authService.disableTwoFactor(request.user!.id, input);
        request.log.info({
            systemEvent: true,
            action: 'auth.2fa_disable',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
        }, '禁用管理员二次验证');
        return { success: true, data: result };
    });
};

export default authRoutes;
