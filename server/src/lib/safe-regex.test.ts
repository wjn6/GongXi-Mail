import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeUserRegex } from './safe-regex.js';

void test('allows simple verification-code patterns', () => {
    assert.equal(isSafeUserRegex('\\d{6}'), true);
    assert.equal(isSafeUserRegex('码[：:]\\s*(\\d{4,8})'), true);
    assert.equal(isSafeUserRegex('[A-Z0-9]{4}-[A-Z0-9]{4}'), true);
    assert.equal(isSafeUserRegex('(GOOGLE|G-)?\\d{6}'), true);
});

void test('rejects nested quantifiers', () => {
    assert.equal(isSafeUserRegex('(a+)+'), false);
    assert.equal(isSafeUserRegex('(a*)*'), false);
    assert.equal(isSafeUserRegex('(\\d{2,4}){3,}'), false);
});

void test('rejects backreferences and lookarounds', () => {
    assert.equal(isSafeUserRegex('(a)\\1'), false);
    assert.equal(isSafeUserRegex('a(?=b)'), false);
    assert.equal(isSafeUserRegex('(?<=x)y'), false);
});

void test('rejects oversized and empty patterns', () => {
    assert.equal(isSafeUserRegex(''), false);
    assert.equal(isSafeUserRegex('a'.repeat(201)), false);
    assert.equal(isSafeUserRegex('a'.repeat(200)), true);
});

void test('allows lazy quantifiers without double counting', () => {
    assert.equal(isSafeUserRegex('\\d+?'), true);
    assert.equal(isSafeUserRegex('.*?code'), true);
});
