const express = require('express');
const { db } = require('./db');
const { notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');

/**
 * 时段通知批次：导演调整排练安排后，演员对“当前时段”的知悉确认。
 *
 * 核心规则：
 *   - 生成（在 schedules.js / rehearsals.js 的原操作事务内完成）：
 *     有效时段创建、起止/场次变化，以及派角/撤派/显式换版使参与演员、角色或版本变化时，
 *     按最终结果生成新批次，冻结 UTC 时段、场次、固定版本与当时参与演员；无实质变化不重复生成。
 *     排期/不可用冲突导致原操作失败时，事务整体回滚，不留批次。
 *   - 旧批次保留为历史（superseded），不计当前待确认；取消/待调整时段的批次转为 inactive，
 *     恢复有效时生成新批次。
 *   - 演员仅能查看含本人的批次，且只能确认“当前有效批次”；重试返回首次确认时间；
 *     过期批次（superseded/inactive 或显式指定了非当前批次）拒绝确认。
 *   - 导演可查看各时段当前批次的已确认/待确认名单及全部历史批次。
 *   - 通知批次不改写已开启的到场登记名单与签到，也不影响台词逐场确认。
 *
 * 依赖方向：notifications.js 只读 schedule_notifications* 与基础表，不引用其他业务模块；
 * 批次的生成与状态联动由 schedules.js 在原操作事务内完成。
 */

const router = express.Router();
router.use(authRequired);

const REASON_LABEL = {
  create: '创建时段',
  adjust: '调整时段/场次',
  restore: '恢复有效',
  cast: '派角变化',
  version: '换版',
};
const STATUS_LABEL = {
  current: '当前有效',
  superseded: '已被新批次取代',
  inactive: '时段已取消或待调整',
};

function getRehearsalOrThrow(id) {
  const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(id);
  if (!r) throw notFound('排练不存在');
  return r;
}

function getScheduleOrThrow(scheduleId, rehearsalId) {
  const s = db
    .prepare('SELECT * FROM rehearsal_schedules WHERE id = ? AND rehearsal_id = ?')
    .get(scheduleId, rehearsalId);
  if (!s) throw notFound('日程安排不存在');
  return s;
}

function baseBatchView(n) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(n.scene_id);
  const version = db.prepare('SELECT version_no FROM versions WHERE id = ?').get(n.version_id);
  return {
    id: n.id,
    scheduleId: n.schedule_id,
    rehearsalId: n.rehearsal_id,
    sceneId: n.scene_id,
    sceneCode: scene?.code ?? null,
    sceneTitle: scene?.title ?? null,
    versionId: n.version_id,
    versionNo: version?.version_no ?? null,
    startAt: n.start_at,
    endAt: n.end_at,
    reason: n.reason,
    reasonLabel: REASON_LABEL[n.reason] ?? n.reason,
    status: n.status,
    statusLabel: STATUS_LABEL[n.status] ?? n.status,
    createdAt: n.created_at,
  };
}

/** 导演视图：完整收件人名单（冻结的角色）与已确认/待确认统计 */
function serializeBatchForDirector(n) {
  const rows = db
    .prepare(
      `SELECT rec.*, u.display_name, u.username
         FROM schedule_notification_recipients rec
         JOIN users u ON u.id = rec.actor_id
        WHERE rec.notification_id = ? ORDER BY rec.id`
    )
    .all(n.id);
  const recipients = rows.map((r) => ({
    actorId: r.actor_id,
    actorName: r.display_name,
    actorUsername: r.username,
    roles: JSON.parse(r.roles_json),
    state: r.acknowledged_at ? 'acknowledged' : 'pending',
    acknowledgedAt: r.acknowledged_at,
  }));
  const acknowledged = recipients.filter((r) => r.acknowledgedAt).length;
  return {
    ...baseBatchView(n),
    recipients,
    stats: { expected: recipients.length, acknowledged, pending: recipients.length - acknowledged },
  };
}

/** 演员视图：仅本人记录（调用方需先确认其在批次收件人中） */
function serializeBatchForActor(n, actorId) {
  const mine = db
    .prepare('SELECT * FROM schedule_notification_recipients WHERE notification_id = ? AND actor_id = ?')
    .get(n.id, actorId);
  return {
    ...baseBatchView(n),
    my: mine
      ? {
          roles: JSON.parse(mine.roles_json),
          state: mine.acknowledged_at ? 'acknowledged' : 'pending',
          acknowledgedAt: mine.acknowledged_at,
        }
      : null,
  };
}

// ---- 查看：导演看当前批次（已确认/待确认名单）与历史；演员只看含本人的批次 ----
router.get(
  '/rehearsals/:id/schedules/:scheduleId/notifications',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    if (req.user.role === 'director') {
      const batches = db
        .prepare('SELECT * FROM schedule_notifications WHERE schedule_id = ? ORDER BY id DESC')
        .all(s.id);
      const current = batches.find((b) => b.status === 'current') ?? null;
      return res.json({
        current: current ? serializeBatchForDirector(current) : null,
        history: batches.filter((b) => b.status !== 'current').map(serializeBatchForDirector),
      });
    }
    // 演员：须在该排练有派角（与日程列表一致的可见性），且只能看到含本人的批次
    const hasRole = db
      .prepare('SELECT 1 FROM rehearsal_cast WHERE rehearsal_id = ? AND actor_id = ?')
      .get(r.id, req.user.id);
    if (!hasRole) throw forbidden('你没有被分配到该排练的任何角色');
    const batches = db
      .prepare(
        `SELECT n.* FROM schedule_notifications n
           JOIN schedule_notification_recipients rec
             ON rec.notification_id = n.id AND rec.actor_id = ?
          WHERE n.schedule_id = ? ORDER BY n.id DESC`
      )
      .all(req.user.id, s.id);
    res.json({ batches: batches.map((b) => serializeBatchForActor(b, req.user.id)) });
  })
);

// ---- 演员：确认当前有效批次（重试返回首次确认时间；过期批次拒绝） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/notifications/ack',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员本人可确认通知');
    const r = getRehearsalOrThrow(req.params.id);
    const s = getScheduleOrThrow(req.params.scheduleId, r.id);
    const current = db
      .prepare("SELECT * FROM schedule_notifications WHERE schedule_id = ? AND status = 'current'")
      .get(s.id);
    if (!current) {
      const any = db.prepare('SELECT 1 FROM schedule_notifications WHERE schedule_id = ? LIMIT 1').get(s.id);
      if (any) throw conflict('NOTIFICATION_STALE', '该时段已取消或待调整，当前没有待确认的通知批次');
      throw notFound('该时段暂无通知批次');
    }
    // 显式指定批次时，过期批次（非当前批次）拒绝
    if (req.body?.notificationId != null && Number(req.body.notificationId) !== current.id) {
      throw conflict('NOTIFICATION_STALE', '该通知批次已过期，请确认当前有效批次');
    }
    const mine = db
      .prepare('SELECT * FROM schedule_notification_recipients WHERE notification_id = ? AND actor_id = ?')
      .get(current.id, req.user.id);
    if (!mine) throw forbidden('你不在当前通知批次名单中，无需确认');
    // 幂等：重试返回首次确认时间
    if (mine.acknowledged_at) {
      return res.json({
        ack: {
          notificationId: current.id,
          scheduleId: s.id,
          actorId: req.user.id,
          acknowledgedAt: mine.acknowledged_at,
          alreadyAcknowledged: true,
        },
      });
    }
    const acknowledgedAt = new Date().toISOString();
    db.prepare('UPDATE schedule_notification_recipients SET acknowledged_at = ? WHERE id = ?').run(
      acknowledgedAt,
      mine.id
    );
    res.status(201).json({
      ack: {
        notificationId: current.id,
        scheduleId: s.id,
        actorId: req.user.id,
        acknowledgedAt,
        alreadyAcknowledged: false,
      },
    });
  })
);

module.exports = { router };
