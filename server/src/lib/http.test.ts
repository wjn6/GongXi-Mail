import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldServeSpaIndex } from './http.js';

void test('should serve SPA index for deep-link HTML request', () => {
    const result = shouldServeSpaIndex({
        method: 'GET',
        path: '/api-keys',
        accept: 'text/html',
    });
    assert.equal(result, true);
});

void test('should return JSON not-found for API namespace', () => {
    const result = shouldServeSpaIndex({
        method: 'GET',
        path: '/api/not-exists',
        accept: 'text/html',
    });
    assert.equal(result, false);
});

void test('should return JSON not-found for explicit JSON accept', () => {
    const result = shouldServeSpaIndex({
        method: 'GET',
        path: '/any-route',
        accept: 'application/json',
    });
    assert.equal(result, false);
});

void test('should return JSON not-found for static asset path', () => {
    const result = shouldServeSpaIndex({
        method: 'GET',
        path: '/assets/main.js',
        accept: '*/*',
    });
    assert.equal(result, false);
});
