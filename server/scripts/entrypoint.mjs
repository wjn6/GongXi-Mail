import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

// 容器入口脚本：
// 1. 确保三件套密钥就绪——显式环境变量优先；未提供且本地无存档时自动生成，
//    持久化到 data/bootstrap-secrets.json（重启与重建容器后保持不变）
// 2. 数据库迁移：全新库直接 deploy；老库（db push 维护）自动基线化后 deploy
// 3. 以组装好的环境变量启动 server，并转发 SIGTERM/SIGINT
// 更新部署因此始终只需要 git pull && docker-compose up -d --build。

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
const SECRET_KEYS = ['JWT_SECRET', 'ENCRYPTION_KEY', 'ADMIN_PASSWORD'];
const SECRETS_FILE = join(process.cwd(), 'data', 'bootstrap-secrets.json');

/**
 * 是否需要把基线标记为已应用：库里有业务表，但迁移历史缺失或没记录基线
 * （即老库此前由 prisma db push 维护，或迁移历史不完整）
 */
export function needsBaseline(hasSchema, hasMigrationTable, baselineApplied) {
    return hasSchema && (!hasMigrationTable || !baselineApplied);
}

/**
 * 汇总密钥：环境变量（含空串视为未设置）优先于本地存档；缺失的项自动生成
 * 返回 { resolved, generated, changed }，generated 里只含本次新生成的键
 */
export function resolveBootstrapSecrets(env, persisted) {
    const resolved = {};
    const generated = [];
    for (const key of SECRET_KEYS) {
        const fromEnv = typeof env[key] === 'string' && env[key].length > 0 ? env[key] : null;
        const fromFile = typeof persisted?.[key] === 'string' && persisted[key].length > 0 ? persisted[key] : null;
        if (fromEnv) {
            resolved[key] = fromEnv;
            continue;
        }
        if (fromFile) {
            resolved[key] = fromFile;
            continue;
        }
        generated.push(key);
        resolved[key] = generateSecret(key);
    }
    return { resolved, generated };
}

function generateSecret(key) {
    if (key === 'ENCRYPTION_KEY') {
        // env 校验要求恰好 32 字符
        return randomBytes(24).toString('base64url');
    }
    if (key === 'JWT_SECRET') {
        return randomBytes(32).toString('base64url');
    }
    return randomBytes(12).toString('base64url');
}

function loadPersistedSecrets() {
    try {
        if (!existsSync(SECRETS_FILE)) {
            return null;
        }
        return JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
    } catch (err) {
        console.warn(`[entrypoint] failed to read ${SECRETS_FILE}, will regenerate missing secrets:`, err.message);
        return null;
    }
}

function persistSecrets(resolved, generated) {
    if (generated.length === 0) {
        return;
    }
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    const existing = loadPersistedSecrets() ?? {};
    const merged = { ...existing };
    for (const key of generated) {
        merged[key] = resolved[key];
    }
    writeFileSync(SECRETS_FILE, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
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

async function runMigrations() {
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
            console.log(`[entrypoint] existing schema detected, marking ${BASELINE_MIGRATION} as applied`);
            execSync(`npx prisma migrate resolve --applied ${BASELINE_MIGRATION}`, { stdio: 'inherit' });
        }
    }

    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
}

async function main() {
    const persisted = loadPersistedSecrets();
    const { resolved, generated } = resolveBootstrapSecrets(process.env, persisted);
    persistSecrets(resolved, generated);

    for (const key of Object.keys(resolved)) {
        process.env[key] = resolved[key];
    }

    if (generated.length > 0) {
        console.log(`[entrypoint] generated secrets: ${generated.join(', ')} (persisted to ${SECRETS_FILE})`);
        if (generated.includes('ADMIN_PASSWORD')) {
            console.log('[entrypoint] initial admin password (shown once): ' + resolved.ADMIN_PASSWORD);
        }
    }

    await runMigrations();
    await prisma.$disconnect();

    const child = spawn(process.execPath, ['dist/index.js'], {
        env: process.env,
        stdio: 'inherit',
    });
    const forward = (signal) => {
        child.kill(signal);
    };
    process.on('SIGTERM', () => forward('SIGTERM'));
    process.on('SIGINT', () => forward('SIGINT'));
    child.on('exit', (code, signal) => {
        process.exit(code ?? (signal === 'SIGTERM' ? 0 : 1));
    });
}

// 仅在作为入口直接执行时启动；被 import 时只暴露纯函数供测试
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error('[entrypoint] failed:', err);
        process.exitCode = 1;
    });
}
