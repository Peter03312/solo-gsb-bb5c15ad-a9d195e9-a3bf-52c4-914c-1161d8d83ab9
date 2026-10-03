const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');

/**
 * 排练日程：导演为已有排练的某场次安排带时区的起止时段（同一场次可安排多段）。
 *
 * 核心规则：
 *   - 参与者 = 该排练当前固定版本中、本场次有台词且已派角的演员（动态计算）；
 *     有台词但未派角的角色列为“待补派”，不阻止安排。
 *   - 场次须属于该剧且在当前固定版本中有台词；结束必须晚于开始。
 *   - 新建/调整时段、派角/改派、换版时，若参与演员与其他“未取消”时段
 *     （待调整不计入）重叠，整次操作拒绝并返回冲突演员与时段（409 SCHEDULE_CONFLICT）。
 *   - 上述操作同时检查参与演员登记的“不可用时段”（actor_unavailability），
 *     相撞即整次不生效，返回演员、日程及不可用时段（409 UNAVAILABILITY_CONFLICT）。
 *   - 端点相接不算重叠（半开区间 [start, end)）。
 *   - 换版后场次在新版本中已无台词的既有安排标为“待调整”，不参与冲突检测；
 *     失败的换版整体回滚，不改变版本与确认。
 *
 * 本模块不引用 rehearsals.js（避免循环依赖），rehearsals.js 在派角/换版事务中
 * 调用这里导出的 assertRehearsalSchedulesAfterCastChange / applySchedulesAfterVersionSwitch。
 */

const router = express.Router();
router.use(authRequired);

// ---- 与 rehearsals.js 解耦的本地小工具 ----
function getRehearsalOrThrow(id) {
  const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(id);
  if (!r) throw notFound('排练不存在');
  return r;
}

function assignedRoleIds(rehearsalId, actorId) {
  return db
    .prepare('SELECT role_id FROM rehearsal_cast WHERE rehearsal_id = ? AND actor_id = ?')
    .all(rehearsalId, actorId)
    .map((r) => r.role_id);
}

/** 带时区的 ISO 8601：2026-10-03T14:00:00+08:00 或 ...Z；归一化为 UTC 存储与比较 */
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
function parseTzDateTime(value, field) {
  const s = String(value ?? '').trim();
  if (!ISO_WITH_TZ.test(s)) {
    throw badRequest(`${field} 必须是带时区的 ISO 8601 时间（如 2026-10-03T14:00:00+08:00 或 2026-10-03T06:00:00Z）`);
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw badRequest(`${field} 不是有效的日期时间`);
  return new Date(ms).toISOString();
}

/**
 * 时段参与者与待补派：
 * 该排练当前固定版本中本场有台词的角色里，已派角的演员为参与者，未派角的角色为待补派。
 */
function participantDetails(rehearsalId, versionId, sceneId) {
  const roleIds = db
    .prepare('SELECT DISTINCT role_id FROM version_lines WHERE version_id = ? AND scene_id = ? ORDER BY role_id')
    .all(versionId, sceneId)
    .map((r) => r.role_id);
  const cast = db
    .prepare(
      `SELECT c.role_id, c.actor_id, u.display_name, u.username
         FROM rehearsal_cast c
         JOIN users u ON u.id = c.actor_id
        WHERE c.rehearsal_id = ?`
    )
    .all(rehearsalId);
  const castMap = new Map(cast.map((c) => [c.role_id, c]));
  const participants = new Map(); // actorId -> { ... , roles: [] }（一人多角时合并）
  const pendingCast = [];
  for (const roleId of roleIds) {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    const c = castMap.get(roleId);
    if (c) {
      if (!participants.has(c.actor_id)) {
        participants.set(c.actor_id, {
          actorId: c.actor_id,
          actorName: c.display_name,
          actorUsername: c.username,
          roles: [],
        });
      }
      participants.get(c.actor_id).roles.push({ roleId, roleCode: role?.code ?? null, roleName: role?.name ?? null });
    } else {
      pendingCast.push({ roleId, roleCode: role?.code ?? null, roleName: role?.name ?? null });
    }
  }
  return { participants: [...participants.values()], pendingCast };
}

/** 半开区间重叠：端点相接（a.end == b.start）不算重叠 */
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/** 构造待检时段（候选）：新建/调整/派角/换版时统一用前瞻数据参与冲突检测 */
function buildCandidate({ scheduleId = null, rehearsal, sceneId, startAt, endAt, versionId }) {
  const { participants } = participantDetails(rehearsal.id, versionId ?? rehearsal.version_id, sceneId);
  return {
    scheduleId,
    rehearsalId: rehearsal.id,
    rehearsalName: rehearsal.name,
    sceneId,
    startAt,
    endAt,
    startMs: Date.parse(startAt),
    endMs: Date.parse(endAt),
    actorIds: participants.map((p) => p.actorId),
  };
}

function slotRef(x) {
  const sceneId = x.sceneId ?? x.scene_id;
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  return {
    id: x.scheduleId ?? x.id ?? null,
    rehearsalId: x.rehearsalId ?? x.rehearsal_id,
    rehearsalName: x.rehearsalName ?? x.rehearsal_name ?? null,
    sceneId,
    sceneTitle: scene ? `${scene.code} ${scene.title}` : null,
    startAt: x.startAt ?? x.start_at,
    endAt: x.endAt ?? x.end_at,
  };
}

function slotKey(x) {
  const id = x.scheduleId ?? x.id;
  if (id != null) return `id:${id}`;
  return `new:${x.rehearsalId ?? x.rehearsal_id}:${x.sceneId ?? x.scene_id}:${x.startAt ?? x.start_at}:${x.endAt ?? x.end_at}`;
}

/**
 * 冲突检测：候选时段的参与演员，与其他“有效”时段（未取消且非待调整）重叠即冲突。
 * 返回按“演员 × 时段对”去重后的冲突列表。
 */
function findScheduleConflicts(candidates) {
  const conflicts = [];
  const seen = new Set();
  const push = (actorId, a, b) => {
    const key = `${actorId}|${slotKey(a)}|${slotKey(b)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const actor = db.prepare('SELECT display_name FROM users WHERE id = ?').get(actorId);
    conflicts.push({
      actorId,
      actorName: actor?.display_name ?? `#${actorId}`,
      schedule: slotRef(a),
      overlapsWith: slotRef(b),
    });
  };

  // 候选之间两两比较（派角/换版会同时重算同一排练的多个时段）
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (!overlaps(a.startMs, a.endMs, b.startMs, b.endMs)) continue;
      for (const actorId of a.actorIds) {
        if (b.actorIds.includes(actorId)) push(actorId, a, b);
      }
    }
  }

  // 候选与库中其它有效时段比较（跨排练、跨剧本：同一演员不能同时出现在两处）
  const candidateIds = new Set(candidates.map((c) => c.scheduleId).filter((id) => id != null));
  const others = db
    .prepare(
      `SELECT s.*, r.version_id, r.name AS rehearsal_name
         FROM rehearsal_schedules s
         JOIN rehearsals r ON r.id = s.rehearsal_id
        WHERE s.status = 'active'`
    )
    .all();
  const partCache = new Map();
  const actorsOf = (row) => {
    if (!partCache.has(row.id)) {
      const { participants } = participantDetails(row.rehearsal_id, row.version_id, row.scene_id);
      partCache.set(row.id, new Set(participants.map((p) => p.actorId)));
    }
    return partCache.get(row.id);
  };
  for (const cand of candidates) {
    for (const s of others) {
      if (candidateIds.has(s.id)) continue; // 同批候选，已在上面两两比较
      if (!overlaps(cand.startMs, cand.endMs, Date.parse(s.start_at), Date.parse(s.end_at))) continue;
      const actorSet = actorsOf(s);
      for (const actorId of cand.actorIds) {
        if (actorSet.has(actorId)) push(actorId, cand, s);
      }
    }
  }
  return conflicts;
}

function assertNoScheduleConflicts(candidates, message = '参与演员与其他未取消时段重叠，本次操作未生效') {
  const conflicts = findScheduleConflicts(candidates);
  if (conflicts.length) throw conflict('SCHEDULE_CONFLICT', message, { conflicts });
}

/** 不可用时段引用（冲突详情用）：返回演员、日程及不可用时段三者中的“不可用时段” */
function unavailabilityRef(u) {
  return { id: u.id, startAt: u.start_at, endAt: u.end_at, reason: u.reason };
}

/**
 * 不可用时段冲突检测：候选时段的参与演员，若其本人登记的不可用时段与候选重叠即冲突。
 * 返回按“演员 × 候选时段 × 不可用记录”去重后的冲突列表（含演员、日程、不可用时段）。
 */
function findUnavailabilityConflicts(candidates) {
  const actorIds = [...new Set(candidates.flatMap((c) => c.actorIds))];
  if (!candidates.length || !actorIds.length) return [];
  const placeholders = actorIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM actor_unavailability WHERE actor_id IN (${placeholders})`)
    .all(...actorIds);
  const conflicts = [];
  const seen = new Set();
  for (const cand of candidates) {
    for (const u of rows) {
      if (!cand.actorIds.includes(u.actor_id)) continue;
      if (!overlaps(cand.startMs, cand.endMs, Date.parse(u.start_at), Date.parse(u.end_at))) continue;
      const key = `${u.actor_id}|${slotKey(cand)}|u:${u.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const actor = db.prepare('SELECT display_name FROM users WHERE id = ?').get(u.actor_id);
      conflicts.push({
        actorId: u.actor_id,
        actorName: actor?.display_name ?? `#${u.actor_id}`,
        schedule: slotRef(cand),
        unavailability: unavailabilityRef(u),
      });
    }
  }
  return conflicts;
}

function assertNoUnavailabilityConflicts(candidates, message) {
  const conflicts = findUnavailabilityConflicts(candidates);
  if (conflicts.length) throw conflict('UNAVAILABILITY_CONFLICT', message, { conflicts });
}

/** 派角/改派后（事务内调用）：整排练的有效时段按新派角重算参与者，冲突则抛 409 回滚 */
function assertRehearsalSchedulesAfterCastChange(rehearsalId) {
  const rehearsal = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
  const rows = db
    .prepare("SELECT * FROM rehearsal_schedules WHERE rehearsal_id = ? AND status = 'active'")
    .all(rehearsalId);
  if (!rows.length) return;
  const candidates = rows.map((s) =>
    buildCandidate({ scheduleId: s.id, rehearsal, sceneId: s.scene_id, startAt: s.start_at, endAt: s.end_at })
  );
  assertNoScheduleConflicts(candidates, '派角后参与演员与其他未取消时段重叠，本次派角未生效');
  assertNoUnavailabilityConflicts(candidates, '派角后参与演员与其登记的不可用时段相撞，本次派角未生效');
}

/**
 * 换版后日程处理（须在换版事务内调用，抛错即整体回滚，版本与确认不变）：
 *   - 新版本中该场次已无台词的既有安排 -> 标为“待调整”，不参与冲突检测；
 *   - 其余有效时段按新版本重算参与者，与其他未取消时段重叠 -> 抛 409。
 * 返回被标为待调整的时段 id 列表。
 */
function applySchedulesAfterVersionSwitch(rehearsalId, newVersionId) {
  const rows = db
    .prepare("SELECT * FROM rehearsal_schedules WHERE rehearsal_id = ? AND status = 'active'")
    .all(rehearsalId);
  if (!rows.length) return [];
  const rehearsal = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
  const needsAdjustment = [];
  const stillActive = [];
  for (const s of rows) {
    const hasLines = db
      .prepare('SELECT 1 FROM version_lines WHERE version_id = ? AND scene_id = ? LIMIT 1')
      .get(newVersionId, s.scene_id);
    if (!hasLines) {
      db.prepare("UPDATE rehearsal_schedules SET status = 'needs_adjustment' WHERE id = ?").run(s.id);
      needsAdjustment.push(s.id);
    } else {
      stillActive.push(s);
    }
  }
  const candidates = stillActive.map((s) =>
    buildCandidate({
      scheduleId: s.id,
      rehearsal,
      sceneId: s.scene_id,
      startAt: s.start_at,
      endAt: s.end_at,
      versionId: newVersionId,
    })
  );
  assertNoScheduleConflicts(candidates, '换版后参与演员与其他未取消时段重叠，本次换版未生效');
  assertNoUnavailabilityConflicts(candidates, '换版后参与演员与其登记的不可用时段相撞，本次换版未生效');
  return needsAdjustment;
}

// ---- 序列化 ----
function getScheduleOrThrow(scheduleId, rehearsalId) {
  const s = db
    .prepare('SELECT * FROM rehearsal_schedules WHERE id = ? AND rehearsal_id = ?')
    .get(scheduleId, rehearsalId);
  if (!s) throw notFound('日程安排不存在');
  return s;
}

function sceneBrief(sceneId) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  return { sceneCode: scene?.code ?? null, sceneTitle: scene?.title ?? null };
}

/** 导演视图：含参与者与待补派；attendance 为该时段到场登记摘要（无登记为 null） */
function serializeSchedule(s, rehearsal) {
  const { participants, pendingCast } = participantDetails(rehearsal.id, rehearsal.version_id, s.scene_id);
  return {
    id: s.id,
    rehearsalId: s.rehearsal_id,
    sceneId: s.scene_id,
    ...sceneBrief(s.scene_id),
    startAt: s.start_at,
    endAt: s.end_at,
    status: s.status,
    participants,
    pendingCast,
    attendance: attendanceSummary(s.id),
    createdAt: s.created_at,
    cancelledAt: s.cancelled_at,
  };
}

/** 到场登记摘要（导演）：状态与统计；作废的登记不计出勤 */
function attendanceSummary(scheduleId) {
  const a = db.prepare('SELECT * FROM attendance_sessions WHERE schedule_id = ?').get(scheduleId);
  if (!a) return null;
  const rows = db.prepare('SELECT checked_in_at FROM attendance_roster WHERE session_id = ?').all(a.id);
  const expected = rows.length;
  const checkedIn = rows.filter((x) => x.checked_in_at).length;
  const counted = a.status !== 'voided';
  return {
    id: a.id,
    status: a.status,
    expected,
    checkedIn,
    absent: counted && a.status === 'closed' ? expected - checkedIn : 0,
    counted,
    scheduleCancelled: !!a.schedule_cancelled,
  };
}

/** 演员视图：只看自己当前参与的有效时段；attendance 为本人登记状态（不在名单为 null） */
function serializeScheduleForActor(s, rehearsal, actorId) {
  const { participants } = participantDetails(rehearsal.id, rehearsal.version_id, s.scene_id);
  const me = participants.find((p) => p.actorId === actorId);
  return {
    id: s.id,
    rehearsalId: s.rehearsal_id,
    sceneId: s.scene_id,
    ...sceneBrief(s.scene_id),
    startAt: s.start_at,
    endAt: s.end_at,
    status: s.status,
    myRoles: me?.roles ?? [],
    attendance: attendanceSummaryForActor(s.id, actorId),
  };
}

/** 到场登记摘要（演员）：仅本人在名单上时返回本人状态 */
function attendanceSummaryForActor(scheduleId, actorId) {
  const a = db.prepare('SELECT * FROM attendance_sessions WHERE schedule_id = ?').get(scheduleId);
  if (!a) return null;
  const mine = db
    .prepare('SELECT checked_in_at FROM attendance_roster WHERE session_id = ? AND actor_id = ?')
    .get(a.id, actorId);
  if (!mine) return null;
  let myState;
  if (mine.checked_in_at) myState = 'checked_in';
  else if (a.status === 'closed') myState = 'absent';
  else if (a.status === 'open') myState = 'pending';
  else myState = 'unmarked';
  return { id: a.id, status: a.status, myState, checkedInAt: mine.checked_in_at };
}

/** 校验场次归属/当前版本有台词 + 起止时间（带时区、结束晚于开始） */
function validateSceneAndTimes(rehearsal, body, existing) {
  const sceneId = body?.sceneId != null ? Number(body.sceneId) : existing?.scene_id;
  if (!Number.isInteger(sceneId)) throw badRequest('sceneId 必填且为整数');
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ? AND play_id = ?').get(sceneId, rehearsal.play_id);
  if (!scene) throw badRequest('场次不存在或不属于该剧');
  const hasLines = db
    .prepare('SELECT 1 FROM version_lines WHERE version_id = ? AND scene_id = ? LIMIT 1')
    .get(rehearsal.version_id, sceneId);
  if (!hasLines) throw badRequest('该场次在排练当前固定版本中没有台词，无法安排');
  const startAt = body?.startAt != null ? parseTzDateTime(body.startAt, 'startAt') : existing?.start_at;
  const endAt = body?.endAt != null ? parseTzDateTime(body.endAt, 'endAt') : existing?.end_at;
  if (!startAt || !endAt) throw badRequest('startAt/endAt 必填');
  if (Date.parse(endAt) <= Date.parse(startAt)) throw badRequest('结束时间必须晚于开始时间');
  return { sceneId, startAt, endAt };
}

// ---- 导演：为某场次安排时段（同一场次可多次安排） ----
router.post(
  '/rehearsals/:id/schedules',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const { sceneId, startAt, endAt } = validateSceneAndTimes(r, req.body, null);
    const id = transaction(() => {
      // 参与演员与其他未取消时段重叠 -> 整次拒绝；参与演员撞上其不可用时段 -> 整次拒绝
      const cand = buildCandidate({ rehearsal: r, sceneId, startAt, endAt });
      assertNoScheduleConflicts([cand]);
      assertNoUnavailabilityConflicts([cand], '参与演员在该时段已登记不可用，本次安排未生效');
      return db
        .prepare(
          'INSERT INTO rehearsal_schedules (rehearsal_id, scene_id, start_at, end_at, created_by) VALUES (?, ?, ?, ?, ?)'
        )
        .run(r.id, sceneId, startAt, endAt, req.user.id).lastInsertRowid;
    });
    res.status(201).json({ schedule: serializeSchedule(getScheduleOrThrow(id, r.id), r) });
  })
);

// ---- 列表：导演看全部（含待补派/待调整/已取消）；演员只看自己当前参与的有效时段 ----
router.get(
  '/rehearsals/:id/schedules',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    if (req.user.role === 'director') {
      let rows = db
        .prepare('SELECT * FROM rehearsal_schedules WHERE rehearsal_id = ? ORDER BY start_at, id')
        .all(r.id);
      const status = req.query.status;
      if (status != null && status !== '') {
        if (!['active', 'needs_adjustment', 'cancelled'].includes(status)) {
          throw badRequest('status 只能是 active / needs_adjustment / cancelled');
        }
        rows = rows.filter((x) => x.status === status);
      }
      return res.json({ schedules: rows.map((s) => serializeSchedule(s, r)) });
    }
    const myRoles = assignedRoleIds(r.id, req.user.id);
    if (myRoles.length === 0) throw forbidden('你没有被分配到该排练的任何角色');
    const rows = db
      .prepare("SELECT * FROM rehearsal_schedules WHERE rehearsal_id = ? AND status = 'active' ORDER BY start_at, id")
      .all(r.id);
    const mine = rows.filter((s) =>
      participantDetails(r.id, r.version_id, s.scene_id).participants.some((p) => p.actorId === req.user.id)
    );
    res.json({ schedules: mine.map((s) => serializeScheduleForActor(s, r, req.user.id)) });
  })
);

// ---- 导演：调整时段（可改场次/起止；待调整的时段调整合法后恢复有效） ----
router.patch(
  '/rehearsals/:id/schedules/:scheduleId',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    if (s.status === 'cancelled') throw badRequest('已取消的安排不能调整，请重新创建');
    const { sceneId, startAt, endAt } = validateSceneAndTimes(r, req.body, s);
    transaction(() => {
      db.prepare(
        "UPDATE rehearsal_schedules SET scene_id = ?, start_at = ?, end_at = ?, status = 'active' WHERE id = ?"
      ).run(sceneId, startAt, endAt, s.id);
      // 调整后的参与演员与其他未取消时段重叠 -> 整次拒绝（事务回滚）；撞上不可用时段同样整次拒绝
      const cand = buildCandidate({ scheduleId: s.id, rehearsal: r, sceneId, startAt, endAt });
      assertNoScheduleConflicts([cand]);
      assertNoUnavailabilityConflicts([cand], '参与演员在该时段已登记不可用，本次调整未生效');
    });
    res.json({ schedule: serializeSchedule(getScheduleOrThrow(s.id, r.id), r) });
  })
);

// ---- 导演：取消安排（保留记录，可查看） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/cancel',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    if (s.status === 'cancelled') throw badRequest('该安排已取消');
    transaction(() => {
      db.prepare("UPDATE rehearsal_schedules SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").run(s.id);
      // 到场登记联动（直接 SQL，避免引用 attendance.js 形成循环依赖）：
      //   开放中的登记 -> 作废：停止签到，已签到痕迹保留但不计出勤；
      //   已关闭的登记 -> 仅标注日程已取消，原统计保留。
      const att = db.prepare('SELECT * FROM attendance_sessions WHERE schedule_id = ?').get(s.id);
      if (att && att.status === 'open') {
        db.prepare("UPDATE attendance_sessions SET status = 'voided' WHERE id = ?").run(att.id);
      } else if (att && att.status === 'closed') {
        db.prepare('UPDATE attendance_sessions SET schedule_cancelled = 1 WHERE id = ?').run(att.id);
      }
    });
    res.json({ ok: true, schedule: serializeSchedule(getScheduleOrThrow(s.id, r.id), r) });
  })
);

module.exports = {
  router,
  assertRehearsalSchedulesAfterCastChange,
  applySchedulesAfterVersionSwitch,
  participantDetails,
  parseTzDateTime,
  slotRef,
};
