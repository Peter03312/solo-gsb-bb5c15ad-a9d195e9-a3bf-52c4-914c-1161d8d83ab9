const express = require('express');
const { db, transaction, roleSceneHash } = require('./db');
const { badRequest, notFound, forbidden, wrap } = require('./errors');
const { authRequired, publicUser } = require('./auth');
const { getPlayOrThrow, getVersionOfPlayOrThrow, formatVersion } = require('./plays');
const { assertRehearsalSchedulesAfterCastChange, applySchedulesAfterVersionSwitch, syncScheduleNotifications } = require('./schedules');

const router = express.Router();
router.use(authRequired);

function getRehearsalOrThrow(id) {
  const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(id);
  if (!r) throw notFound('排练不存在');
  return r;
}

/** 当前用户在该排练中被派的角色（演员） */
function assignedRoleIds(rehearsalId, actorId) {
  return db
    .prepare('SELECT role_id FROM rehearsal_cast WHERE rehearsal_id = ? AND actor_id = ?')
    .all(rehearsalId, actorId)
    .map((r) => r.role_id);
}

// ---- 排练管理（导演） ----
router.post(
  '/plays/:id/rehearsals',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const play = getPlayOrThrow(req.params.id);
    const versionId = Number(req.body?.versionId);
    if (!Number.isInteger(versionId)) throw badRequest('创建排练时必须固定指定一个版本 versionId');
    const version = getVersionOfPlayOrThrow(versionId, play.id);
    const name = String(req.body?.name || '').trim() || `排练 @v${version.version_no}`;
    const info = transaction(() => {
      return db
        .prepare('INSERT INTO rehearsals (play_id, version_id, name, created_by) VALUES (?, ?, ?, ?)')
        .run(play.id, versionId, name, req.user.id);
    });
    res.status(201).json({
      id: info.lastInsertRowid,
      playId: play.id,
      versionId,
      name,
    });
  })
);

router.get(
  '/rehearsals',
  wrap((req, res) => {
    let rows;
    if (req.user.role === 'director') {
      rows = db.prepare('SELECT * FROM rehearsals ORDER BY id').all();
    } else {
      rows = db
        .prepare(
          `SELECT DISTINCT r.* FROM rehearsals r
             JOIN rehearsal_cast c ON c.rehearsal_id = r.id
            WHERE c.actor_id = ? ORDER BY r.id`
        )
        .all(req.user.id);
    }
    res.json({ rehearsals: rows.map(serializeRehearsal) });
  })
);

function serializeRehearsal(r) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(r.version_id);
  const play = db.prepare('SELECT id, title FROM plays WHERE id = ?').get(r.play_id);
  return {
    id: r.id,
    playId: r.play_id,
    playTitle: play?.title ?? null,
    name: r.name,
    versionId: r.version_id,
    versionNo: version?.version_no ?? null,
    createdAt: r.created_at,
  };
}

/**
 * 排练详情。
 * 导演可见：派角、待确认（逐角色逐场次）、换版历史。
 * 演员仅在被派角时可见，且只看自己的部分。
 */
router.get(
  '/rehearsals/:id',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    const isDirector = req.user.role === 'director';
    const myRoles = isDirector ? [] : assignedRoleIds(r.id, req.user.id);
    if (!isDirector && myRoles.length === 0) throw forbidden();

    const cast = db
      .prepare(
        `SELECT c.*, ro.name AS role_name, ro.code AS role_code,
                u.display_name AS actor_name, u.username AS actor_username
           FROM rehearsal_cast c
           JOIN roles ro ON ro.id = c.role_id
           JOIN users u ON u.id = c.actor_id
          WHERE c.rehearsal_id = ? ORDER BY ro.id`
      )
      .all(r.id);

    let visibleCast = cast;
    if (!isDirector) {
      visibleCast = cast.filter((c) => c.actor_id === req.user.id);
    }

    const payload = {
      rehearsal: serializeRehearsal(r),
      cast: visibleCast.map((c) => ({
        roleId: c.role_id,
        roleCode: c.role_code,
        roleName: c.role_name,
        actorId: c.actor_id,
        actorName: c.actor_name,
        actorUsername: c.actor_username,
        assignedAt: c.assigned_at,
      })),
      pending: rehearsalPending(r, isDirector ? null : req.user.id),
      versionLog: db
        .prepare(
          `SELECT vl.*, v1.version_no AS from_no, v2.version_no AS to_no
             FROM rehearsal_version_log vl
             JOIN versions v1 ON v1.id = vl.from_version_id
             JOIN versions v2 ON v2.id = vl.to_version_id
            WHERE vl.rehearsal_id = ? ORDER BY vl.id`
        )
        .all(r.id)
        .map((l) => ({
          fromVersionId: l.from_version_id,
          toVersionId: l.to_version_id,
          fromNo: l.from_no,
          toNo: l.to_no,
          byActorId: l.actor_id,
          at: l.created_at,
        })),
    };

    if (isDirector) {
      // 导演页：展示该剧最近一次发布尝试的冲突详情
      const lastAttempt = db
        .prepare('SELECT * FROM publish_attempts WHERE play_id = ? ORDER BY id DESC LIMIT 1')
        .get(r.play_id);
      if (lastAttempt) {
        payload.lastPublishAttempt = {
          id: lastAttempt.id,
          hadConflict: !!lastAttempt.had_conflict,
          newVersionId: lastAttempt.new_version_id,
          note: lastAttempt.note,
          createdAt: lastAttempt.created_at,
          conflicts: db
            .prepare('SELECT * FROM publish_conflicts WHERE attempt_id = ? ORDER BY id')
            .all(lastAttempt.id)
            .map((c) => ({
              revisionId: c.revision_id,
              lineId: c.line_id,
              kind: c.kind,
              reason: c.reason,
              baseText: c.base_text,
              currentText: c.current_text,
            })),
        };
      }
    }
    res.json(payload);
  })
);

/**
 * 计算排练中“待确认”的演员 × 角色 × 场次。
 * 规则：
 *   - 只统计当前已派角、且该版本该角色在场次中有台词的条目
 *   - 当前演员无确认记录 => 尚未确认
 *   - 有其他演员的确认记录 => 角色已改派，原演员确认不计入
 *   - 当前演员的 content_hash 与现版本不一致 => 换版后台词文本已变化
 * 换版后仅文本变化的角色×场次需重新确认。
 */
function rehearsalPending(rehearsal, actorIdFilter) {
  const versionId = rehearsal.version_id;
  const cast = db
    .prepare(
      actorIdFilter
        ? `SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? AND actor_id = ?`
        : `SELECT * FROM rehearsal_cast WHERE rehearsal_id = ?`
    )
    .all(...(actorIdFilter ? [rehearsal.id, actorIdFilter] : [rehearsal.id]));

  const pending = [];
  for (const c of cast) {
    const scenes = db
      .prepare(
        `SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ? ORDER BY scene_id`
      )
      .all(versionId, c.role_id);
    for (const { scene_id } of scenes) {
      const mine = db
        .prepare(
          'SELECT * FROM confirmations WHERE rehearsal_id = ? AND role_id = ? AND scene_id = ? AND actor_id = ?'
        )
        .get(rehearsal.id, c.role_id, scene_id, c.actor_id);
      const others = db
        .prepare(
          'SELECT COUNT(*) AS n FROM confirmations WHERE rehearsal_id = ? AND role_id = ? AND scene_id = ? AND actor_id <> ?'
        )
        .get(rehearsal.id, c.role_id, scene_id, c.actor_id).n;
      const hash = roleSceneHash(versionId, c.role_id, scene_id);
      const done = mine && mine.content_hash === hash;
      if (!done) {
        const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(scene_id);
        const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(c.role_id);
        const actor = db.prepare('SELECT * FROM users WHERE id = ?').get(c.actor_id);
        let reason;
        if (!mine && others > 0) reason = '角色已改派，原演员确认不计入';
        else if (mine) reason = '换版后台词文本已变化，需重新确认';
        else reason = '尚未确认';
        pending.push({
          actorId: c.actor_id,
          actorName: actor?.display_name ?? `#${c.actor_id}`,
          roleId: c.role_id,
          roleName: role?.name ?? `#${c.role_id}`,
          sceneId: scene_id,
          sceneTitle: scene ? `${scene.code} ${scene.title}` : `#${scene_id}`,
          reason,
        });
      }
    }
  }
  return pending;
}

// ---- 显式换版 ----
router.post(
  '/rehearsals/:id/switch-version',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const targetVersionId = Number(req.body?.versionId);
    if (!Number.isInteger(targetVersionId)) throw badRequest('必须显式指定目标版本 versionId');
    const target = getVersionOfPlayOrThrow(targetVersionId, r.play_id);
    if (targetVersionId === r.version_id) throw badRequest('排练当前已固定在该版本');

    let needsAdjustmentSchedules = [];
    transaction(() => {
      const old = r.version_id;
      // 仅保留“角色×场次”文本指纹在新旧版本间一致的确认；
      // 文本变化（含角色在该场次不再有台词）的确认删除，相关角色需重新确认。
      const cast = db.prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ?').all(r.id);
      for (const c of cast) {
        const newScenes = new Set(
          db
            .prepare('SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ?')
            .all(targetVersionId, c.role_id)
            .map((x) => x.scene_id)
        );
        const confirmations = db
          .prepare('SELECT * FROM confirmations WHERE rehearsal_id = ? AND role_id = ?')
          .all(r.id, c.role_id);
        for (const conf of confirmations) {
          if (!newScenes.has(conf.scene_id)) {
            db.prepare('DELETE FROM confirmations WHERE id = ?').run(conf.id);
            continue;
          }
          const oldHash = roleSceneHash(old, c.role_id, conf.scene_id);
          const newHash = roleSceneHash(targetVersionId, c.role_id, conf.scene_id);
          // 仅保留与旧版内容一致、且新旧内容未变的确认（文本变化角色须重确）
          if (conf.content_hash !== oldHash || oldHash !== newHash) {
            db.prepare('DELETE FROM confirmations WHERE id = ?').run(conf.id);
          }
        }
      }
      db.prepare('UPDATE rehearsals SET version_id = ? WHERE id = ?').run(targetVersionId, r.id);
      db.prepare(
        'INSERT INTO rehearsal_version_log (rehearsal_id, from_version_id, to_version_id, actor_id) VALUES (?, ?, ?, ?)'
      ).run(r.id, old, targetVersionId, req.user.id);
      // 日程：新版本中无台词场次的既有安排标为“待调整”（不计入冲突）；
      // 其余有效时段按新版本重算参与者，与其他未取消时段重叠则抛 409，
      // 整个事务回滚——版本与确认均不改变。
      needsAdjustmentSchedules = applySchedulesAfterVersionSwitch(r.id, targetVersionId);
      // 时段通知：仍有效的时段按新版本生成新批次（版本变化即实质变化）；
      // 待调整时段的当前批次不再待确认。与同事务提交，换版失败不留批次。
      syncScheduleNotifications(r.id, 'version_switch', req.user.id);
    });

    res.json({
      ok: true,
      rehearsal: serializeRehearsal(getRehearsalOrThrow(r.id)),
      pending: rehearsalPending(getRehearsalOrThrow(r.id), null),
      needsAdjustmentSchedules,
    });
  })
);

// ---- 派角 / 改派 ----
router.post(
  '/rehearsals/:id/cast',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    const roleId = Number(req.body?.roleId);
    const actorId = Number(req.body?.actorId);
    if (!Number.isInteger(roleId) || !Number.isInteger(actorId)) throw badRequest('roleId/actorId 必填');
    const role = db.prepare('SELECT * FROM roles WHERE id = ? AND play_id = ?').get(roleId, r.play_id);
    if (!role) throw badRequest('角色不存在或不属于该剧');
    const actor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'actor'").get(actorId);
    if (!actor) throw badRequest('演员不存在');

    const result = transaction(() => {
      const existing = db
        .prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?')
        .get(r.id, roleId);
      let outcome;
      if (existing) {
        if (existing.actor_id === actorId) return { unchanged: true };
        // 改派：保留原演员的历史确认（待确认计算时不再计入），新演员需逐场重新确认
        db.prepare('UPDATE rehearsal_cast SET actor_id = ?, assigned_at = datetime(\'now\') WHERE id = ?').run(
          actorId,
          existing.id
        );
        outcome = { reassigned: true, fromActorId: existing.actor_id };
      } else {
        db.prepare('INSERT INTO rehearsal_cast (rehearsal_id, role_id, actor_id) VALUES (?, ?, ?)').run(
          r.id,
          roleId,
          actorId
        );
        outcome = { created: true };
      }
      // 派角/改派后：该排练有效时段的参与演员若与其他未取消时段重叠，
      // 抛 409 整次回滚（派角不生效），响应携带冲突演员与时段。
      assertRehearsalSchedulesAfterCastChange(r.id);
      // 派角/改派改变参与演员 -> 同事务生成新通知批次（无实质变化不重复生成）
      syncScheduleNotifications(r.id, 'cast', req.user.id);
      return outcome;
    });
    res.status(result.created ? 201 : 200).json({ ok: true, ...result });
  })
);

router.delete(
  '/rehearsals/:id/cast/:roleId',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden();
    const r = getRehearsalOrThrow(req.params.id);
    transaction(() => {
      // 取消派角：历史确认保留在库中作为痕迹，但已无派角对应，不会再计入待确认
      db.prepare('DELETE FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?').run(
        r.id,
        req.params.roleId
      );
      // 撤派改变参与演员 -> 同事务生成新通知批次（无实质变化不重复生成）
      syncScheduleNotifications(r.id, 'cast', req.user.id);
    });
    res.json({ ok: true });
  })
);

// ---- 演员：排练稿（只看自己所派角色的台词） ----
router.get(
  '/rehearsals/:id/script',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    if (req.user.role !== 'actor') throw forbidden('演员视图仅供演员使用');
    const roleIds = assignedRoleIds(r.id, req.user.id);
    if (roleIds.length === 0) throw forbidden('你没有被分配到该排练的任何角色');

    const placeholders = roleIds.map(() => '?').join(',');
    const lines = db
      .prepare(
        `SELECT vl.*, s.code AS scene_code, s.title AS scene_title, s.seq AS scene_seq,
                ro.code AS role_code, ro.name AS role_name
           FROM version_lines vl
           JOIN scenes s ON s.id = vl.scene_id
           JOIN roles ro ON ro.id = vl.role_id
          WHERE vl.version_id = ? AND vl.role_id IN (${placeholders})
          ORDER BY s.seq, s.id, vl.seq, vl.id`
      )
      .all(r.version_id, ...roleIds);

    // 同时返回每个角色×场次的确认状态
    const status = [];
    for (const roleId of new Set(roleIds)) {
      const scenes = db
        .prepare(
          'SELECT DISTINCT scene_id FROM version_lines WHERE version_id = ? AND role_id = ? ORDER BY scene_id'
        )
        .all(r.version_id, roleId);
      for (const { scene_id } of scenes) {
        const conf = db
          .prepare(
            'SELECT * FROM confirmations WHERE rehearsal_id = ? AND role_id = ? AND scene_id = ? AND actor_id = ?'
          )
          .get(r.id, roleId, scene_id, req.user.id);
        status.push({
          roleId,
          sceneId: scene_id,
          confirmed: !!(conf && conf.content_hash === roleSceneHash(r.version_id, roleId, scene_id)),
          confirmedAt: conf?.confirmed_at ?? null,
        });
      }
    }

    res.json({
      rehearsal: serializeRehearsal(r),
      lines: lines.map((l) => ({
        lineId: l.line_id,
        sceneId: l.scene_id,
        sceneCode: l.scene_code,
        sceneTitle: l.scene_title,
        sceneSeq: l.scene_seq,
        roleId: l.role_id,
        roleCode: l.role_code,
        roleName: l.role_name,
        seq: l.seq,
        text: l.text,
      })),
      confirmations: status,
    });
  })
);

// ---- 演员：逐场确认 ----
router.post(
  '/rehearsals/:id/confirm',
  wrap((req, res) => {
    const r = getRehearsalOrThrow(req.params.id);
    if (req.user.role !== 'actor') throw forbidden('只有演员可以确认台词');
    const roleId = Number(req.body?.roleId);
    const sceneId = Number(req.body?.sceneId);
    if (!Number.isInteger(roleId) || !Number.isInteger(sceneId)) throw badRequest('roleId/sceneId 必填');

    // 越权：角色必须是当前演员在该排练中获分配的
    const castRow = db
      .prepare('SELECT * FROM rehearsal_cast WHERE rehearsal_id = ? AND role_id = ?')
      .get(r.id, roleId);
    if (!castRow || castRow.actor_id !== req.user.id) {
      throw forbidden('你未被分配该角色，不能代为确认');
    }
    // 场次必须属于该剧且该角色在该版本该场次有台词
    const scene = db
      .prepare(
        `SELECT s.* FROM scenes s
           JOIN version_lines vl ON vl.scene_id = s.id AND vl.version_id = ?
          WHERE s.id = ? AND vl.role_id = ? LIMIT 1`
      )
      .get(r.version_id, sceneId, roleId);
    if (!scene) throw badRequest('该版本下此角色在此场次没有台词，无需确认');

    const hash = roleSceneHash(r.version_id, roleId, sceneId);
    transaction(() => {
      db.prepare(
        `INSERT INTO confirmations (rehearsal_id, role_id, actor_id, scene_id, content_hash)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (rehearsal_id, role_id, scene_id, actor_id)
         DO UPDATE SET content_hash = excluded.content_hash,
                       confirmed_at = datetime('now')`
      ).run(r.id, roleId, req.user.id, sceneId, hash);
    });
    res.json({ ok: true, roleId, sceneId, confirmedAt: new Date().toISOString() });
  })
);

module.exports = { router, rehearsalPending };
