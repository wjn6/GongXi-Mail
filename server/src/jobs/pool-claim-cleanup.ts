import { poolService } from '../modules/mail/pool.service.js';
import { logger } from '../lib/logger.js';

const INTERVAL_MS = 60 * 1000;
let running = false;

async function runOnce() {
    if (running) {
        return;
    }
    running = true;
    try {
        const deleted = await poolService.cleanupExpiredClaims();
        if (deleted > 0) {
            logger.info({ deleted }, 'Expired email claims released');
        }
    } catch (err) {
        logger.error({ err }, 'Expired email claim cleanup failed');
    } finally {
        running = false;
    }
}

/**
 * 定期回收已过期的邮箱领取记录。
 * 查询层面已将过期领取视为可用，此任务仅用于保持表数据整洁。
 */
export function startPoolClaimCleanupJob(): () => void {
    void runOnce();
    const timer = setInterval(() => {
        void runOnce();
    }, INTERVAL_MS);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
    return () => clearInterval(timer);
}
