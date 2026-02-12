import { type FastifyPluginAsync, type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';

export class AppError extends Error {
    constructor(
        public code: string,
        message: string,
        public statusCode: number = 400
    ) {
        super(message);
        this.name = 'AppError';
    }
}

const errorPlugin: FastifyPluginAsync = async (fastify) => {
    fastify.setErrorHandler((error: FastifyError | AppError | ZodError, request: FastifyRequest, reply: FastifyReply) => {
        logger.error({ err: error, path: request.url, method: request.method, requestId: request.id }, 'Request error');

        // Zod 验证错误
        if (error instanceof ZodError) {
            return reply.status(400).send({
                success: false,
                requestId: request.id,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request data',
                    details: error.errors,
                },
            });
        }

        // 自定义应用错误
        if (error instanceof AppError) {
            return reply.status(error.statusCode).send({
                success: false,
                requestId: request.id,
                error: {
                    code: error.code,
                    message: error.message,
                },
            });
        }

        // Fastify 验证错误
        if (error.validation) {
            return reply.status(400).send({
                success: false,
                requestId: request.id,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: error.message,
                },
            });
        }

        // 未知错误
        const statusCode = error.statusCode || 500;
        return reply.status(statusCode).send({
            success: false,
            requestId: request.id,
            error: {
                code: 'INTERNAL_ERROR',
                message: statusCode === 500 ? 'Internal server error' : error.message,
            },
        });
    });

    // 注意：404 处理已移至 app.ts 以支持 SPA 路由
};

export default fp(errorPlugin, { name: 'error' });
