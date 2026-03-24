import { PrismaClient as PostgresPrismaClient, type Prisma } from '@prisma/client';
import { PrismaClient as SqlitePrismaClient } from '../generated/sqlite-client/index.js';
import { env } from '../config/env.js';

const globalForPrisma = globalThis as unknown as {
    prisma: PostgresPrismaClient | undefined;
};

function createPrismaClient() {
    const log: Array<Prisma.LogLevel> = env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'];
    const baseOptions = { log };

    if (env.DATABASE_PROVIDER === 'sqlite') {
        return new SqlitePrismaClient(baseOptions) as unknown as PostgresPrismaClient;
    }

    return new PostgresPrismaClient(baseOptions);
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

export default prisma;
