export type UtcTrendRange = {
    safeDays: number;
    startDate: Date;
    endDate: Date;
    nextDate: Date;
    dateKeys: string[];
};

function formatUtcDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function getUtcTrendRange(days: number, now: Date = new Date()): UtcTrendRange {
    const safeDays = Math.max(1, Math.min(days, 90));
    const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - safeDays + 1);
    const nextDate = new Date(endDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);

    const dateKeys: string[] = [];
    for (let i = 0; i < safeDays; i += 1) {
        const day = new Date(startDate);
        day.setUTCDate(startDate.getUTCDate() + i);
        dateKeys.push(formatUtcDateKey(day));
    }

    return {
        safeDays,
        startDate,
        endDate,
        nextDate,
        dateKeys,
    };
}

export function buildApiTrend(createdAtList: Date[], dateKeys: string[]): Array<{ date: string; count: number }> {
    const countsByDate = new Map<string, number>();
    for (const createdAt of createdAtList) {
        const dateKey = formatUtcDateKey(createdAt);
        countsByDate.set(dateKey, (countsByDate.get(dateKey) || 0) + 1);
    }

    return dateKeys.map(date => ({
        date,
        count: countsByDate.get(date) || 0,
    }));
}
