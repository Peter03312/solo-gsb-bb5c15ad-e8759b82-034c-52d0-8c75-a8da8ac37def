'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { packageFingerprint } = require('../src/import');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM imported_batches;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function getState() {
  const r = await call('GET', '/api/editor/state');
  assert.strictEqual(r.status, 200);
  return r.json;
}

function samplePackage(overrides = {}) {
  return {
    batchId: 'batch-2026-a',
    events: [
      {
        key: 'dongyuan',
        title: '修水渠动员会',
        description: '大队在晒谷场召开动员会。',
        claims: [
          { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述，2021-07-05 访谈，录音 03 段', note: '记得很清楚' },
          { precision: 'year', year: 1958, source: '《县水利志》1994 年版，第 87 页' },
        ],
      },
      {
        key: 'tongshui',
        title: '东干渠通水',
        claims: [{ precision: 'month', year: 1959, month: 5, source: '王秀兰口述，2021-08-02 访谈' }],
      },
    ],
    relations: [
      { earlierKey: 'dongyuan', laterKey: 'tongshui', source: '李宝山、王秀兰二人口述一致', note: '' },
    ],
    ...overrides,
  };
}

test('导入预览/确认接口需要编辑者口令', async () => {
  const r1 = await call('POST', '/api/editor/import-preview', { token: null, body: samplePackage() });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('POST', '/api/editor/import-confirm', {
    token: null,
    body: { package: samplePackage(), fingerprint: 'x', draftRevisionNo: 0 },
  });
  assert.strictEqual(r2.status, 401);
});

test('预览只读：列出待写入内容与数量、指纹和修订号，不写任何数据', async () => {
  const pkg = samplePackage();
  const before = await getState();
  assert.strictEqual(before.events.length, 0);

  const r = await call('POST', '/api/editor/import-preview', { body: pkg });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.batchId, 'batch-2026-a');
  assert.deepStrictEqual(r.json.counts, { eventCount: 2, claimCount: 3, relationCount: 1 });
  assert.strictEqual(r.json.fingerprint, packageFingerprint(pkg));
  assert.strictEqual(r.json.draftRevisionNo, 0);
  assert.strictEqual(r.json.currentVersionNo, 0);
  assert.strictEqual(r.json.alreadyImported, false);
  assert.strictEqual(r.json.previousImport, null);

  // 待写入内容：精度区间由服务端按现有规则计算
  const dy = r.json.events.find((e) => e.key === 'dongyuan');
  assert.strictEqual(dy.claims.length, 2);
  assert.strictEqual(dy.claims[0].dateLabel, '1958 年 09 月 12 日');
  assert.strictEqual(dy.claims[0].intervalStart, '1958-09-12');
  assert.strictEqual(dy.claims[0].intervalEnd, '1958-09-12');
  assert.strictEqual(r.json.events.find((e) => e.key === 'tongshui').claims[0].intervalEnd, '1959-05-31');
  assert.deepStrictEqual(r.json.relations[0], {
    earlierKey: 'dongyuan',
    laterKey: 'tongshui',
    source: '李宝山、王秀兰二人口述一致',
    note: '',
  });

  // 预览不写库、不推进修订号
  const after = await getState();
  assert.strictEqual(after.events.length, 0);
  assert.strictEqual(after.draftRevisionNo, before.draftRevisionNo);
});

test('键重复：列出问题并整包拒绝（422），不写任何数据', async () => {
  const pkg = samplePackage({
    events: [
      { key: 'k1', title: '甲', claims: [{ precision: 'year', year: 1958, source: 's' }] },
      { key: 'k1', title: '乙', claims: [{ precision: 'year', year: 1959, source: 's' }] },
    ],
    relations: [],
  });
  const r = await call('POST', '/api/editor/import-preview', { body: pkg });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.errors.length, 1);
  assert.strictEqual(r.json.errors[0].type, 'duplicate_key');
  assert.match(r.json.errors[0].message, /k1/);

  // 确认路径同样拒绝
  const c = await call('POST', '/api/editor/import-confirm', {
    body: { package: pkg, fingerprint: packageFingerprint(pkg), draftRevisionNo: 0 },
  });
  assert.strictEqual(c.status, 422);
  assert.strictEqual((await getState()).events.length, 0);
});

test('关系引用缺失：列出缺失键并整包拒绝', async () => {
  const pkg = samplePackage({
    events: [{ key: 'a', title: '甲', claims: [{ precision: 'year', year: 1958, source: 's' }] }],
    relations: [{ earlierKey: 'a', laterKey: 'ghost' }],
  });
  const r = await call('POST', '/api/editor/import-preview', { body: pkg });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.errors.length, 1);
  assert.strictEqual(r.json.errors[0].type, 'relation_reference');
  assert.deepStrictEqual(r.json.errors[0].missingKeys, ['ghost']);
});

test('自环关系被拒；日期非法（含不存在的日期）与出处为空被逐条列出', async () => {
  const pkg = {
    batchId: 'bad-batch',
    events: [
      { key: 'a', title: '甲', claims: [{ precision: 'day', year: 1958, month: 2, day: 30, source: 's' }] },
      { key: 'b', title: '乙', claims: [{ precision: 'month', year: 1959, month: 3, source: '' }] },
    ],
    relations: [{ earlierKey: 'a', laterKey: 'a' }],
  };
  const r = await call('POST', '/api/editor/import-preview', { body: pkg });
  assert.strictEqual(r.status, 422);
  const types = r.json.errors.map((e) => e.type).sort();
  assert.deepStrictEqual(types, ['invalid_claim', 'invalid_claim', 'self_relation']);
});

test('事件没有主张 / batchId 或标题为空：整包拒绝', async () => {
  const noClaims = samplePackage({
    events: [{ key: 'x', title: '空事件', claims: [] }],
    relations: [],
  });
  const r1 = await call('POST', '/api/editor/import-preview', { body: noClaims });
  assert.strictEqual(r1.status, 422);
  assert.strictEqual(r1.json.errors[0].type, 'missing_claims');

  const noBatch = samplePackage({ batchId: '   ' });
  const r2 = await call('POST', '/api/editor/import-preview', { body: noBatch });
  assert.strictEqual(r2.status, 422);
  assert.strictEqual(r2.json.errors.some((e) => e.type === 'invalid_batch'), true);

  const badTop = await call('POST', '/api/editor/import-preview', { body: [1, 2, 3] });
  assert.strictEqual(badTop.status, 422);
  assert.strictEqual(badTop.json.errors[0].type, 'invalid_package');
});

test('确认成功：事务内追加整包，返回键→草稿ID映射与新修订号，只推进一次修订', async () => {
  const pkg = samplePackage();
  const pv = await call('POST', '/api/editor/import-preview', { body: pkg });
  assert.strictEqual(pv.status, 200);
  assert.strictEqual(pv.json.draftRevisionNo, 0);

  const ok = await call('POST', '/api/editor/import-confirm', {
    body: { package: pkg, fingerprint: pv.json.fingerprint, draftRevisionNo: pv.json.draftRevisionNo },
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.batchId, 'batch-2026-a');
  assert.strictEqual(ok.json.revisionNo, 1);
  assert.strictEqual(ok.json.currentVersionNo, 0);
  assert.deepStrictEqual(ok.json.counts, { eventCount: 2, claimCount: 3, relationCount: 1 });

  // 键 → 草稿事件 id
  const ids = ok.json.keys;
  assert.ok(ids.dongyuan > 0 && ids.tongshui > 0);
  assert.notStrictEqual(ids.dongyuan, ids.tongshui);

  const em = ok.json.idMap.events;
  assert.deepStrictEqual(em.map((m) => m.key), ['dongyuan', 'tongshui']);
  assert.strictEqual(em[0].eventId, ids.dongyuan);
  assert.strictEqual(em[0].claims.length, 2);
  assert.strictEqual(em[1].claims.length, 1);
  const rm = ok.json.idMap.relations[0];
  assert.deepStrictEqual(
    { k: rm.earlierKey, e: rm.earlierEventId, lk: rm.laterKey, le: rm.laterEventId },
    { k: 'dongyuan', e: ids.dongyuan, lk: 'tongshui', le: ids.tongshui }
  );

  // 草稿确已写入：事件、主张、关系
  const st = await getState();
  assert.strictEqual(st.events.length, 2);
  assert.strictEqual(st.draftRevisionNo, 1);
  const dy = st.events.find((e) => e.title === '修水渠动员会');
  assert.strictEqual(dy.claims.length, 2);
  assert.strictEqual(st.relations.length, 1);
  assert.strictEqual(st.relations[0].earlierId, ids.dongyuan);
  assert.strictEqual(st.relations[0].laterId, ids.tongshui);
  assert.strictEqual(st.relations[0].source, '李宝山、王秀兰二人口述一致');

  // 返回的 draft 与 state 一致
  assert.strictEqual(ok.json.draft.counts.eventCount, 2);
  assert.strictEqual(ok.json.draft.counts.claimCount, 3);
});

test('内容被替换（指纹不符）：409 PACKAGE_FINGERPRINT_MISMATCH，不写入', async () => {
  const pkg = samplePackage();
  const pv = await call('POST', '/api/editor/import-preview', { body: pkg });

  // 确认时偷换了内容：改一个出处
  const tampered = samplePackage();
  tampered.events[1].claims[0].source = '被替换的出处';
  const r = await call('POST', '/api/editor/import-confirm', {
    body: { package: tampered, fingerprint: pv.json.fingerprint, draftRevisionNo: pv.json.draftRevisionNo },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'PACKAGE_FINGERPRINT_MISMATCH');
  assert.strictEqual(r.json.actualFingerprint, packageFingerprint(tampered));

  const st = await getState();
  assert.strictEqual(st.events.length, 0);
  assert.strictEqual(st.draftRevisionNo, 0);
});

test('草稿在预览后被改动（修订号过期）：409 DRAFT_REVISION_CONFLICT，不写入', async () => {
  const pkg = samplePackage();
  const pv = await call('POST', '/api/editor/import-preview', { body: pkg });
  assert.strictEqual(pv.json.draftRevisionNo, 0);

  // 另一编辑者改了草稿
  const add = await call('POST', '/api/editor/events', { body: { title: '并发加入', description: '' } });
  assert.strictEqual(add.status, 201);

  const r = await call('POST', '/api/editor/import-confirm', {
    body: { package: pkg, fingerprint: pv.json.fingerprint, draftRevisionNo: 0 },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'DRAFT_REVISION_CONFLICT');
  assert.strictEqual(r.json.currentRevisionNo, 1);

  const st = await getState();
  assert.strictEqual(st.events.length, 1);
  assert.strictEqual(st.events[0].title, '并发加入');
  assert.strictEqual(st.draftRevisionNo, 1);
});

test('批次标识曾成功导入：确认 409 BATCH_ALREADY_IMPORTED，预览可见 alreadyImported', async () => {
  const pkg = samplePackage();
  const pv = await call('POST', '/api/editor/import-preview', { body: pkg });
  const ok = await call('POST', '/api/editor/import-confirm', {
    body: { package: pkg, fingerprint: pv.json.fingerprint, draftRevisionNo: 0 },
  });
  assert.strictEqual(ok.status, 201);

  // 内容相同、修订号为当前值，仍因批次重复被拒
  const pv2 = await call('POST', '/api/editor/import-preview', { body: pkg });
  assert.strictEqual(pv2.status, 200);
  assert.strictEqual(pv2.json.alreadyImported, true);
  assert.strictEqual(pv2.json.previousImport.batchId, 'batch-2026-a');
  assert.strictEqual(pv2.json.previousImport.eventCount, 2);

  const again = await call('POST', '/api/editor/import-confirm', {
    body: { package: pkg, fingerprint: pv2.json.fingerprint, draftRevisionNo: pv2.json.draftRevisionNo },
  });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.json.code, 'BATCH_ALREADY_IMPORTED');
  assert.strictEqual(again.json.previousImport.batchId, 'batch-2026-a');

  // 即便删掉草稿内容，同批次依旧不能导入（台账不随草稿清空）
  const st = await getState();
  for (const id of st.events.map((e) => e.id)) {
    await call('DELETE', `/api/editor/events/${id}`);
  }
  assert.strictEqual((await getState()).events.length, 0);
  const pv3 = await call('POST', '/api/editor/import-preview', { body: pkg });
  const third = await call('POST', '/api/editor/import-confirm', {
    body: { package: pkg, fingerprint: pv3.json.fingerprint, draftRevisionNo: pv3.json.draftRevisionNo },
  });
  assert.strictEqual(third.status, 409);
  assert.strictEqual(third.json.code, 'BATCH_ALREADY_IMPORTED');
});

test('追加而非替换：导入包追加到已有草稿之后，旧事件保持不变', async () => {
  // 草稿原有一个事件
  const old = await call('POST', '/api/editor/events', { body: { title: '旧事件', description: '原本就有' } });
  assert.strictEqual(old.status, 201);
  const oldId = old.json.event.id;

  const pkg = samplePackage();
  const pv = await call('POST', '/api/editor/import-preview', { body: pkg });
  assert.strictEqual(pv.json.draftRevisionNo, 1);
  const ok = await call('POST', '/api/editor/import-confirm', {
    body: { package: pkg, fingerprint: pv.json.fingerprint, draftRevisionNo: 1 },
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.revisionNo, 2);

  const st = await getState();
  assert.strictEqual(st.events.length, 3);
  const still = st.events.find((e) => e.id === oldId);
  assert.strictEqual(still.title, '旧事件');
  assert.strictEqual(still.description, '原本就有');
  assert.ok(st.events.some((e) => e.title === '修水渠动员会'));

  // 不同批次可再追加
  const pkg2 = samplePackage({ batchId: 'batch-2026-b' });
  const pv2 = await call('POST', '/api/editor/import-preview', { body: pkg2 });
  const ok2 = await call('POST', '/api/editor/import-confirm', {
    body: { package: pkg2, fingerprint: pv2.json.fingerprint, draftRevisionNo: pv2.json.draftRevisionNo },
  });
  assert.strictEqual(ok2.status, 201, JSON.stringify(ok2.json));
  assert.strictEqual((await getState()).events.length, 5);
});

test('历史快照与访客视图不受导入影响；导入内容仍须选择+校验后发布', async () => {
  // 先发布第 1 版
  const e1 = (await call('POST', '/api/editor/events', { body: { title: '老事件' } })).json.event.id;
  const c1 = (await call('POST', `/api/editor/events/${e1}/claims`, {
    body: { precision: 'year', year: 1950, source: '档案甲' },
  })).json.claim.id;
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0, editor: '甲' },
  });
  assert.strictEqual(pub.status, 201);

  // 导入新批次（含与老事件无关的内容）
  const pkg = samplePackage();
  const pv = await call('POST', '/api/editor/import-preview', { body: pkg });
  const ok = await call('POST', '/api/editor/import-confirm', {
    body: { package: pkg, fingerprint: pv.json.fingerprint, draftRevisionNo: pv.json.draftRevisionNo },
  });
  assert.strictEqual(ok.status, 201);

  // 访客视图与最新版本号完全不变
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.eventCount, 1);
  assert.strictEqual(view.json.version.events[0].title, '老事件');

  // 新内容进入草稿，发布时必须为每个事件选主张；漏选 -> 422
  const st = await getState();
  const selOld = [{ eventId: e1, claimId: c1 }];
  const badPub = await call('POST', '/api/editor/publish', {
    body: { selection: selOld, baseVersionNo: 1 },
  });
  assert.strictEqual(badPub.status, 422);
  assert.ok(badPub.json.errors.some((er) => er.type === 'missing'));

  // 全部选定（动员会选 day 主张、通水 month 主张，先后可解）后正常发布为第 2 版
  const ids = ok.json.keys;
  const st2 = await getState();
  const claimId = (eventId, n) => st2.events.find((e) => e.id === eventId).claims[n].id;
  const selection = [
    { eventId: e1, claimId: c1 },
    { eventId: ids.dongyuan, claimId: claimId(ids.dongyuan, 0) },
    { eventId: ids.tongshui, claimId: claimId(ids.tongshui, 0) },
  ];
  const val = await call('POST', '/api/editor/validate', { body: { selection } });
  assert.strictEqual(val.status, 200);
  assert.strictEqual(val.json.ok, true);
  const pub2 = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 1, editor: '乙', note: '导入批次后发布' },
  });
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));
  assert.strictEqual(pub2.json.versionNo, 2);
  assert.strictEqual(pub2.json.version.eventCount, 3);
});

test('确认参数非法返回 400', async () => {
  const pkg = samplePackage();
  const bad = async (body) => (await call('POST', '/api/editor/import-confirm', { body })).status;
  assert.strictEqual(await bad({ fingerprint: 'x', draftRevisionNo: 0 }), 400);               // 缺 package
  assert.strictEqual(await bad({ package: pkg, draftRevisionNo: 0 }), 400);                 // 缺 fingerprint
  assert.strictEqual(await bad({ package: pkg, fingerprint: 'x', draftRevisionNo: -1 }), 400);
  assert.strictEqual(await bad({ package: pkg, fingerprint: '', draftRevisionNo: 0 }), 400);
  assert.strictEqual(await bad(null), 400);
});

test('内容指纹对键顺序与空白不敏感：同内容不同书写顺序仍一致', async () => {
  const a = samplePackage();
  const reordered = {
    relations: [],
    events: [
      {
        claims: [
          { source: '李宝山口述，2021-07-05 访谈，录音 03 段', day: 12, month: 9, year: 1958, precision: 'day', note: '记得很清楚' },
          { source: '《县水利志》1994 年版，第 87 页', year: 1958, precision: 'year' },
        ],
        description: '大队在晒谷场召开动员会。',
        title: '修水渠动员会',
        key: 'dongyuan',
      },
      {
        claims: [{ source: '王秀兰口述，2021-08-02 访谈', month: 5, year: 1959, precision: 'month' }],
        title: '东干渠通水',
        key: 'tongshui',
      },
    ],
    // 关系对象内部键序也重排；内容与 a 完全相同
    relations: [
      { note: '', source: '李宝山、王秀兰二人口述一致', laterKey: 'tongshui', earlierKey: 'dongyuan' },
    ],
    batchId: 'batch-2026-a',
  };
  assert.strictEqual(packageFingerprint(reordered), packageFingerprint(a));
});
