import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { env } from './config/env.js';
import errorPlugin from './plugins/error.js';
import authPlugin from './plugins/auth.js';

// Routes
import authRoutes from './modules/auth/auth.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import apiKeyRoutes from './modules/api-key/apiKey.routes.js';
import emailRoutes from './modules/email/email.routes.js';
import groupRoutes from './modules/email/group.routes.js';
import mailRoutes from './modules/mail/mail.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
    const fastify = Fastify({
        logger: env.NODE_ENV === 'development' ? {
            transport: {
                target: 'pino-pretty',
                options: { colorize: true },
            },
        } : true,
    });

    // 插件
    await fastify.register(fastifyCors, {
        origin: true,
        credentials: true,
    });

    await fastify.register(fastifyHelmet, {
        contentSecurityPolicy: false, // 允许前端加载
    });

    await fastify.register(fastifyCookie);

    // 自定义插件
    await fastify.register(errorPlugin);
    await fastify.register(authPlugin);

    // 健康检查
    fastify.get('/health', async () => {
        return {
            success: true,
            data: {
                status: 'ok',
            },
        };
    });

    // 静态文件（前端）- 禁用 fastify-static 的默认 404 处理
    await fastify.register(fastifyStatic, {
        root: join(__dirname, '../../public'),
        prefix: '/',
        wildcard: false, // 禁用通配符，让我们自定义处理 SPA
    });

    // API 路由
    await fastify.register(authRoutes, { prefix: '/admin/auth' });
    await fastify.register(adminRoutes, { prefix: '/admin/admins' });
    await fastify.register(apiKeyRoutes, { prefix: '/admin/api-keys' });
    await fastify.register(emailRoutes, { prefix: '/admin/emails' });
    await fastify.register(groupRoutes, { prefix: '/admin/email-groups' });
    await fastify.register(dashboardRoutes, { prefix: '/admin/dashboard' });

    // 外部 API
    await fastify.register(mailRoutes, { prefix: '/api' });

    // SPA fallback - 现在可以安全使用 setNotFoundHandler
    fastify.setNotFoundHandler(async (request, reply) => {
        // 如果是 API 路由，返回 404 JSON
        if (request.url.startsWith('/api') || request.url.startsWith('/admin')) {
            return reply.status(404).send({
                success: false,
                error: { code: 'NOT_FOUND', message: 'Route not found' },
            });
        }

        // 否则返回 index.html（SPA）
        return reply.sendFile('index.html');
    });

    return fastify;
}

export default buildApp;
