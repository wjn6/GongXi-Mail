import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import prisma from './lib/prisma.js';

async function main() {
    const app = await buildApp();

    // 优雅关闭
    const shutdown = async () => {
        logger.info('Shutting down...');
        await app.close();
        await prisma.$disconnect();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        // 测试数据库连接
        await prisma.$connect();
        logger.info('Database connected');

        // 启动服务器
        await app.listen({ port: env.PORT, host: '0.0.0.0' });
        logger.info(`Server running at http://localhost:${env.PORT}`);
    } catch (err) {
        logger.error({ err }, 'Failed to start server');
        process.exit(1);
    }
}

void main();
