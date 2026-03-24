import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApiTrend, getUtcTrendRange } from './dashboard/dashboard.trend.js';

void test('getUtcTrendRange should generate stable UTC window and date keys', () => {
    const now = new Date('2026-03-24T15:45:20.000+08:00');
    const range = getUtcTrendRange(3, now);

    assert.equal(range.startDate.toISOString(), '2026-03-22T00:00:00.000Z');
    assert.equal(range.endDate.toISOString(), '2026-03-24T00:00:00.000Z');
    assert.equal(range.nextDate.toISOString(), '2026-03-25T00:00:00.000Z');
    assert.deepEqual(range.dateKeys, ['2026-03-22', '2026-03-23', '2026-03-24']);
});

void test('getUtcTrendRange should clamp days into [1, 90]', () => {
    const now = new Date('2026-03-24T00:10:00.000Z');
    const minRange = getUtcTrendRange(0, now);
    const maxRange = getUtcTrendRange(999, now);

    assert.equal(minRange.safeDays, 1);
    assert.equal(minRange.dateKeys.length, 1);
    assert.equal(maxRange.safeDays, 90);
    assert.equal(maxRange.dateKeys.length, 90);
});

void test('buildApiTrend should aggregate by UTC day and fill zero counts', () => {
    const trend = buildApiTrend(
        [
            new Date('2026-03-21T00:10:00.000Z'),
            new Date('2026-03-21T12:10:00.000Z'),
            new Date('2026-03-23T23:59:59.000Z'),
        ],
        ['2026-03-21', '2026-03-22', '2026-03-23']
    );

    assert.deepEqual(trend, [
        { date: '2026-03-21', count: 2 },
        { date: '2026-03-22', count: 0 },
        { date: '2026-03-23', count: 1 },
    ]);
});
