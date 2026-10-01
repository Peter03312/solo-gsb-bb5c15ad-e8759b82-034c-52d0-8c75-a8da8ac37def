'use strict';

// JSON 采访整理包导入：只读预览 + 事务确认，整包追加到当前草稿。
//
// 包结构：
//   {
//     batchId: '批次标识（字符串，同一标识只能成功导入一次）',
//     events: [
//       { key: '包内唯一键', title, description?,
//         claims: [ { precision:'year|month|day', year, month?, day?, source, note? } ] }
//     ],
//     relations: [ { earlierKey, laterKey, source?, note? } ]  // 按键引用事件
//   }
//
// 预览（buildImportPreview）只读：校验整包、计算内容指纹、清点待写入数量，
//   同时返回当前草稿修订号；包有任何问题都整包拒绝，不写数据。
//
// 确认（confirmImport）必须原样回提交预览的包、预览返回的指纹与草稿修订号：
//   - 内容被替换（重算指纹不一致）   → 409 PACKAGE_FINGERPRINT_MISMATCH
//   - 草稿已变化（修订号不一致）     → 409 DRAFT_REVISION_CONFLICT
//   - 批次标识曾成功导入             → 409 BATCH_ALREADY_IMPORTED（永久台账，恢复/清空草稿也不能再导）
//   通过后在一个事务内追加整包，修订号只推进一次。
// 不触碰 versions 区，历史快照与访客视图不受影响；新内容仍为草稿，发布照旧走选择与先后校验。

const crypto = require('crypto');
const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { latestVersionNo } = require('./publish');
const { draftRevisionNo, currentDraftSnapshot } = require('./restore');

const LIMITS = {
  batchId: 100,
  key: 100,
  title: 200,
  description: 5000,
  claimSource: 1000,
  claimNote: 2000,
  relationSource: 1000,
  relationNote: 2000,
};

// ---------- 内容指纹：规范化 JSON（对象键排序、数组保序）后取 SHA-256 ----------
// 指纹只取决于包的逻辑内容，与原始空白、键的书写顺序无关；预览与确认各算一次，
// 两次一致才允许写入，确保「确认的就是预览的那份内容」。
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function packageFingerprint(pkg) {
  const hex = crypto.createHash('sha256').update(canonicalJson(pkg), 'utf8').digest('hex');
  return `sha256:${hex}`;
}

// ---------- 整包校验：收集全部问题，任一问题即整包拒绝 ----------
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function validatePackage(pkg) {
  const errors = [];
  const push = (type, message, extra = {}) => errors.push({ type, message, ...extra });

  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    push('invalid_package', '请求体必须是一个 JSON 对象（采访整理包）');
    return { ok: false, errors };
  }

  // 批次标识
  if (!isNonEmptyString(pkg.batchId)) {
    push('invalid_batch', 'batchId 必须是非空字符串（批次标识）', { field: 'batchId' });
  } else if (pkg.batchId.length > LIMITS.batchId) {
    push('invalid_batch', `batchId 长度不能超过 ${LIMITS.batchId}`, { field: 'batchId' });
  }

  // 事件表
  if (!Array.isArray(pkg.events)) {
    push('invalid_package', 'events 必须是事件数组', { field: 'events' });
    return { ok: false, errors, batchId: typeof pkg.batchId === 'string' ? pkg.batchId : null };
  }

  const validKeys = new Set();
  const normalizedEvents = [];

  pkg.events.forEach((ev, i) => {
    const path = `events[${i}]`;
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      push('invalid_event', `${path} 必须是事件对象`, { path });
      return;
    }

    let key = null;
    if (!isNonEmptyString(ev.key)) {
      push('invalid_event', `${path}.key 必须是非空字符串（包内唯一键）`, { path, field: 'key' });
    } else if (ev.key.length > LIMITS.key) {
      push('invalid_event', `${path}.key 长度不能超过 ${LIMITS.key}`, { path, field: 'key' });
    } else if (validKeys.has(ev.key)) {
      push('duplicate_key', `事件键「${ev.key}」在包内重复，键必须唯一`, { path, key: ev.key });
    } else {
      key = ev.key;
      validKeys.add(key);
    }

    if (!isNonEmptyString(ev.title)) {
      push('invalid_event', `${path}${key ? `（键「${key}」）` : ''} 的 title 不能为空`, {
        path,
        key,
        field: 'title',
      });
    } else if (ev.title.length > LIMITS.title) {
      push('invalid_event', `${path} 的 title 长度不能超过 ${LIMITS.title}`, { path, key, field: 'title' });
    }

    if (ev.description != null && (typeof ev.description !== 'string' || ev.description.length > LIMITS.description)) {
      push('invalid_event', `${path} 的 description 必须是不超过 ${LIMITS.description} 字符的字符串`, {
        path,
        key,
        field: 'description',
      });
    }

    if (!Array.isArray(ev.claims)) {
      push('invalid_event', `${path}${key ? `（键「${key}」）` : ''} 的 claims 必须是主张数组`, {
        path,
        key,
        field: 'claims',
      });
      return;
    }
    if (ev.claims.length === 0) {
      push('missing_claims', `${path}（键「${key}」）没有任何时间主张，每个事件至少需要一条`, {
        path,
        key,
        field: 'claims',
      });
    }

    const claims = [];
    ev.claims.forEach((c, j) => {
      const cpath = `${path}.claims[${j}]`;
      if (c === null || typeof c !== 'object' || Array.isArray(c)) {
        push('invalid_claim', `${cpath} 必须是主张对象`, { path: cpath, key });
        return;
      }
      if (!isNonEmptyString(c.source)) {
        push('invalid_claim', `${cpath} 的出处 source 不能为空（受访人 / 档案 / 页码等）`, {
          path: cpath,
          key,
          field: 'source',
        });
      } else if (c.source.length > LIMITS.claimSource) {
        push('invalid_claim', `${cpath} 的 source 长度不能超过 ${LIMITS.claimSource}`, {
          path: cpath,
          key,
          field: 'source',
        });
      }
      if (c.note != null && (typeof c.note !== 'string' || c.note.length > LIMITS.claimNote)) {
        push('invalid_claim', `${cpath} 的 note 必须是不超过 ${LIMITS.claimNote} 字符的字符串`, {
          path: cpath,
          key,
          field: 'note',
        });
      }
      // 年/月/日精度与合法性复用现有录入路径（含闰年、大小月）
      let parsed = null;
      try {
        parsed = parseClaimDate(c);
      } catch (err) {
        push('invalid_claim', `${cpath} 日期非法：${err.message}`, { path: cpath, key, field: 'date' });
      }
      if (parsed && isNonEmptyString(c.source)) {
        const iv = claimInterval(parsed.precision, parsed.year, parsed.month, parsed.day);
        claims.push({
          precision: parsed.precision,
          year: parsed.year,
          month: parsed.month,
          day: parsed.day,
          dateLabel: formatClaimDate(parsed.precision, parsed.year, parsed.month, parsed.day),
          intervalStart: iv.start,
          intervalEnd: iv.end,
          source: c.source,
          note: typeof c.note === 'string' ? c.note : '',
        });
      }
    });

    if (key) normalizedEvents.push({ key, title: ev.title, description: typeof ev.description === 'string' ? ev.description : '', claims });
  });

  // 关系表（按键引用）
  const normalizedRelations = [];
  if (pkg.relations != null && !Array.isArray(pkg.relations)) {
    push('invalid_package', 'relations 必须是数组', { field: 'relations' });
  } else if (Array.isArray(pkg.relations)) {
    pkg.relations.forEach((r, i) => {
      const path = `relations[${i}]`;
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        push('invalid_relation', `${path} 必须是关系对象`, { path });
        return;
      }
      const earlierKey = isNonEmptyString(r.earlierKey) ? r.earlierKey : null;
      const laterKey = isNonEmptyString(r.laterKey) ? r.laterKey : null;
      if (!earlierKey) {
        push('invalid_relation', `${path}.earlierKey 必须是非空字符串（引用包内事件键）`, {
          path,
          field: 'earlierKey',
        });
      } else if (earlierKey.length > LIMITS.key) {
        push('invalid_relation', `${path}.earlierKey 长度不能超过 ${LIMITS.key}`, { path, field: 'earlierKey' });
      }
      if (!laterKey) {
        push('invalid_relation', `${path}.laterKey 必须是非空字符串（引用包内事件键）`, {
          path,
          field: 'laterKey',
        });
      } else if (laterKey.length > LIMITS.key) {
        push('invalid_relation', `${path}.laterKey 长度不能超过 ${LIMITS.key}`, { path, field: 'laterKey' });
      }
      if (r.source != null && (typeof r.source !== 'string' || r.source.length > LIMITS.relationSource)) {
        push('invalid_relation', `${path} 的 source 必须是不超过 ${LIMITS.relationSource} 字符的字符串`, {
          path,
          field: 'source',
        });
      }
      if (r.note != null && (typeof r.note !== 'string' || r.note.length > LIMITS.relationNote)) {
        push('invalid_relation', `${path} 的 note 必须是不超过 ${LIMITS.relationNote} 字符的字符串`, {
          path,
          field: 'note',
        });
      }
      if (earlierKey && laterKey) {
        if (earlierKey === laterKey) {
          // 自环在现有关系录入时即被禁止，整包导入同样拒绝
          push('self_relation', `${path} 自相矛盾：事件「${earlierKey}」不能先于自身`, {
            path,
            key: earlierKey,
          });
        } else {
          const missing = [];
          if (!validKeys.has(earlierKey)) missing.push(earlierKey);
          if (!validKeys.has(laterKey)) missing.push(laterKey);
          if (missing.length) {
            push(
              'relation_reference',
              `${path} 引用了包内不存在的事件键：${missing.map((k) => `「${k}」`).join('、')}`,
              { path, earlierKey, laterKey, missingKeys: missing }
            );
          } else {
            normalizedRelations.push({
              earlierKey,
              laterKey,
              source: typeof r.source === 'string' ? r.source : '',
              note: typeof r.note === 'string' ? r.note : '',
            });
          }
        }
      }
    });
  }

  if (errors.length) return { ok: false, errors, batchId: typeof pkg.batchId === 'string' ? pkg.batchId : null };

  const counts = {
    eventCount: normalizedEvents.length,
    claimCount: normalizedEvents.reduce((n, e) => n + e.claims.length, 0),
    relationCount: normalizedRelations.length,
  };
  return { ok: true, errors: [], normalized: { batchId: pkg.batchId, events: normalizedEvents, relations: normalizedRelations }, counts };
}

// ---------- 批次台账 ----------
function importedBatchRow(batchId) {
  const row = getDb()
    .prepare(
      `SELECT batch_id AS batchId, fingerprint, event_count AS eventCount,
              claim_count AS claimCount, relation_count AS relationCount,
              base_revision AS baseRevision, revision, imported_at AS importedAt
         FROM imported_batches WHERE batch_id = ?`
    )
    .get(batchId);
  return row || null;
}

// ---------- 只读预览：不写任何数据 ----------
function buildImportPreview(pkg) {
  const checked = validatePackage(pkg);
  if (!checked.ok) {
    throw {
      status: 422,
      message: '采访整理包校验未通过，整包拒绝（未写入任何内容）',
      errors: checked.errors,
    };
  }
  const { normalized, counts } = checked;
  const previous = importedBatchRow(normalized.batchId);

  const events = normalized.events.map((ev) => ({
    key: ev.key,
    title: ev.title,
    description: ev.description,
    claims: ev.claims.map((c) => ({
      precision: c.precision,
      year: c.year,
      month: c.month,
      day: c.day,
      dateLabel: c.dateLabel,
      intervalStart: c.intervalStart,
      intervalEnd: c.intervalEnd,
      source: c.source,
      note: c.note,
    })),
  }));

  return {
    batchId: normalized.batchId,
    fingerprint: packageFingerprint(pkg),
    draftRevisionNo: draftRevisionNo(),
    currentVersionNo: latestVersionNo(),
    counts,
    events,
    relations: normalized.relations.map((r) => ({ earlierKey: r.earlierKey, laterKey: r.laterKey, source: r.source, note: r.note })),
    alreadyImported: !!previous,
    previousImport: previous,
  };
}

// ---------- 确认：在一个事务内整包追加 ----------
function confirmImport({ pkg, fingerprint, expectedRevision }) {
  if (!isNonEmptyString(fingerprint)) {
    throw { status: 400, message: 'fingerprint 必须是非空字符串（取预览返回的内容指纹）' };
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw { status: 400, message: 'draftRevisionNo 必须是非负整数（取预览返回的草稿修订号）' };
  }

  const checked = validatePackage(pkg);
  if (!checked.ok) {
    throw {
      status: 422,
      message: '采访整理包校验未通过，整包拒绝（未写入任何内容）',
      errors: checked.errors,
    };
  }
  const { normalized, counts } = checked;

  // 内容核对：确认包里的内容必须与预览时逐字节同一份（规范化后比较）
  const actualFingerprint = packageFingerprint(pkg);
  if (actualFingerprint !== fingerprint) {
    throw {
      status: 409,
      code: 'PACKAGE_FINGERPRINT_MISMATCH',
      message: '内容冲突：提交的包与预览时不一致（内容已被替换或改动）。请重新预览后再确认。',
      expectedFingerprint: fingerprint,
      actualFingerprint,
    };
  }

  const db = getDb();

  const tx = db.transaction(() => {
    // 乐观并发：预览与确认之间草稿若被任何人增删改过（修订号变化），拒绝写入
    const revision = draftRevisionNo();
    if (revision !== expectedRevision) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message: `草稿冲突：预览时草稿修订号为 ${expectedRevision}，现在已变为 ${revision}（期间草稿被修改过）。请重新预览后再确认。`,
        currentRevisionNo: revision,
        expectedRevisionNo: expectedRevision,
      };
    }

    // 批次标识永久唯一：曾成功导入即拒绝（台账不受清空/恢复草稿影响）
    const previous = importedBatchRow(normalized.batchId);
    if (previous) {
      throw {
        status: 409,
        code: 'BATCH_ALREADY_IMPORTED',
        message: `批次标识「${normalized.batchId}」已于 ${previous.importedAt} 成功导入过，同一批次不能重复导入。`,
        batchId: normalized.batchId,
        previousImport: previous,
      };
    }

    const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
    const insClaim = db.prepare(`
      INSERT INTO claims
        (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insRel = db.prepare(
      'INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)'
    );

    const eventIdByKey = new Map();
    const eventMaps = [];
    normalized.events.forEach((ev) => {
      const eventId = insEvent.run(ev.title, ev.description).lastInsertRowid;
      eventIdByKey.set(ev.key, eventId);
      const claimIds = ev.claims.map((c, index) => ({
        index,
        claimId: insClaim
          .run(eventId, c.precision, c.year, c.month, c.day, c.dateLabel, c.intervalStart, c.intervalEnd, c.source, c.note)
          .lastInsertRowid,
      }));
      eventMaps.push({ key: ev.key, eventId, claims: claimIds });
    });

    const relationMaps = normalized.relations.map((r, index) => {
      const earlierEventId = eventIdByKey.get(r.earlierKey);
      const laterEventId = eventIdByKey.get(r.laterKey);
      const relationId = insRel.run(earlierEventId, laterEventId, r.source, r.note).lastInsertRowid;
      return { index, relationId, earlierKey: r.earlierKey, earlierEventId, laterKey: r.laterKey, laterEventId };
    });

    const insBatch = db.prepare(`
      INSERT INTO imported_batches
        (batch_id, fingerprint, event_count, claim_count, relation_count, base_revision, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insBatch.run(
      normalized.batchId,
      fingerprint,
      counts.eventCount,
      counts.claimCount,
      counts.relationCount,
      expectedRevision,
      expectedRevision + 1
    );

    // 每条 INSERT 都触发了修订号自增；整包追加是一次原子操作，只应算一次草稿变更，
    // 最终校正为预览时修订号 + 1（与恢复草稿的约定一致）。
    db.prepare('UPDATE draft_meta SET revision = ? WHERE id = 1').run(expectedRevision + 1);

    return { eventMaps, relationMaps };
  });

  const { eventMaps, relationMaps } = tx();

  return {
    batchId: normalized.batchId,
    revisionNo: draftRevisionNo(),
    currentVersionNo: latestVersionNo(),
    counts,
    idMap: { events: eventMaps, relations: relationMaps },
    // 包内键 → 草稿事件 id 的直接映射
    keys: Object.fromEntries(eventMaps.map((m) => [m.key, m.eventId])),
    draft: currentDraftSnapshot(),
  };
}

module.exports = {
  validatePackage,
  packageFingerprint,
  canonicalJson,
  buildImportPreview,
  confirmImport,
  importedBatchRow,
};
