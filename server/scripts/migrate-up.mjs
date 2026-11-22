import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// 容器启动迁移脚本：
// - 全新数据库：直接 migrate deploy 应用基线
// - 老数据库（此前由 prisma db push 维护）：自动把基线标记为已应用，再 deploy
// 由此部署更新始终只需要重启容器，不需要手动执行 resolve。

const BASELINE_MIGRATION = '20260222000000_init';
const KNOWN_TABLES = [
    'admins',
    'api_keys',
    'email_accounts',
    'email_groups',
    'email_usage',
    'api_logs',
    'system_config',
];

/**
 * 是否需要把基线标记为已应用：库里有业务表，但迁移历史缺失或没记录基线
 * （即老库此前由 prisma db push 维护，或迁移历史不完整）
 */
export function needsBaseline(hasSchema, hasMigrationTable, baselineApplied) {
    return hasSchema && (!hasMigrationTable || !baselineApplied);
}

const prisma = new PrismaClient();

async function tableExists(tableName) {
    const rows = await prisma.$queryRaw`
        SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = ${tableName}
        ) AS "exists"
    `;
    return rows[0]?.exists === true;
}

async function main() {
    let hasSchema = false;
    for (const tableName of KNOWN_TABLES) {
        if (await tableExists(tableName)) {
            hasSchema = true;
            break;
        }
    }

    if (hasSchema) {
        const hasMigrationTable = await tableExists('_prisma_migrations');
        let baselineApplied = false;
        if (hasMigrationTable) {
            const rows = await prisma.$queryRaw`
                SELECT COUNT(*)::int AS count
                FROM "_prisma_migrations"
                WHERE migration_name = ${BASELINE_MIGRATION}
            `;
            baselineApplied = Number(rows[0]?.count) > 0;
        }

        if (needsBaseline(hasSchema, hasMigrationTable, baselineApplied)) {
            console.log(`[migrate-up] existing schema detected, marking ${BASELINE_MIGRATION} as applied`);
            execSync(`npx prisma migrate resolve --applied ${BASELINE_MIGRATION}`, { stdio: 'inherit' });
        }
    }

    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
}

main()
    .catch((err) => {
        console.error('[migrate-up] failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
