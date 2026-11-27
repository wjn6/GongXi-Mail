import assert from 'node:assert/strict';
import test from 'node:test';
import { ImportLineError, formatExportLine, parseImportLine } from './account-import.js';

const CID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const GRAPH_CID = '229ef870-f0ec-40fe-9499-bc3a03560916';

void test('parses the 6-column Graph + IMAP format', () => {
    const line = `a@outlook.com----pw123----${GRAPH_CID}----M.C5_graph_rt----${CID}----M.C5_imap_rt`;
    assert.deepEqual(parseImportLine(line), {
        email: 'a@outlook.com',
        password: 'pw123',
        clientId: GRAPH_CID,
        refreshToken: 'M.C5_graph_rt',
        imapClientId: CID,
        imapRefreshToken: 'M.C5_imap_rt',
    });
});

void test('6-column format tolerates CRLF, spaces and empty IMAP columns', () => {
    const parsed = parseImportLine(`  a@outlook.com----pw----${GRAPH_CID}----rt--------\r`);
    assert.deepEqual(parsed, { email: 'a@outlook.com', password: 'pw', clientId: GRAPH_CID, refreshToken: 'rt' });

    const same = parseImportLine(`a@outlook.com----pw----${GRAPH_CID}----rt----${GRAPH_CID}----rt`);
    assert.equal(same.imapClientId, undefined);
    assert.equal(same.imapRefreshToken, undefined);
});

void test('keeps the existing 3, 4 and 5 column formats', () => {
    assert.deepEqual(parseImportLine(`a@outlook.com----${CID}----rt`), { email: 'a@outlook.com', clientId: CID, refreshToken: 'rt' });
    assert.deepEqual(parseImportLine(`a@outlook.com----pw----${CID}----rt`), { email: 'a@outlook.com', password: 'pw', clientId: CID, refreshToken: 'rt' });
    assert.deepEqual(parseImportLine(`a@outlook.com----${CID}----uuid----info----rt`), { email: 'a@outlook.com', clientId: CID, refreshToken: 'rt' });
    // 6 columns that are not Graph + IMAP fall back to the 5-column rule (as before)
    assert.deepEqual(parseImportLine(`a@outlook.com----${CID}----uuid----info----rt----extra`), { email: 'a@outlook.com', clientId: CID, refreshToken: 'rt' });
    assert.deepEqual(parseImportLine('a@outlook.com|cid|rt', '|'), { email: 'a@outlook.com', clientId: 'cid', refreshToken: 'rt' });
});

void test('rejects broken lines', () => {
    assert.throws(() => parseImportLine('a@outlook.com----rt'), ImportLineError);
    assert.throws(() => parseImportLine(`not-an-email----${CID}----rt`), ImportLineError);
    assert.throws(() => parseImportLine(`a@outlook.com----pw----${GRAPH_CID}----rt----${CID}----`), /provided together/);
    assert.throws(() => parseImportLine('a@outlook.com----cid----rt', ''), ImportLineError);
});

void test('exports 6 columns only for accounts with separate IMAP credentials', () => {
    assert.equal(formatExportLine({ email: 'a@x.com', clientId: 'c', refreshToken: 'r' }), 'a@x.com----c----r');
    const six = formatExportLine({ email: 'a@x.com', password: null, clientId: GRAPH_CID, refreshToken: 'r', imapClientId: CID, imapRefreshToken: 'ir' });
    assert.equal(six, `a@x.com--------${GRAPH_CID}----r----${CID}----ir`);
    assert.deepEqual(parseImportLine(six), { email: 'a@x.com', clientId: GRAPH_CID, refreshToken: 'r', imapClientId: CID, imapRefreshToken: 'ir' });
});
