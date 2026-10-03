const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

/**
 * 轻量结构迁移：PRAGMA user_version 单调递增。
 * v1 -> v2：confirmations 唯一键加入 actor_id（改派保留历史确认）。
 * v2 -> v3：为存量的“有效”日程时段补建初始通知批次（已取消/待调整不补，
 *           参与者按当时固定版本与派角计算；新库由 schema.sql 直接建表，此处仅补数据）。
 */
function migrate() {
  const from = db.pragma('user_version', { simple: true });
  if (from < 2) {
    // 旧唯一索引覆盖 3 列（rehearsal_id, role_id, scene_id）；新版为 4 列（含 actor_id）
    const indexes = db.prepare("PRAGMA index_list('confirmations')").all();
    let legacy = false;
    for (const ix of indexes) {
      if (ix.unique !== 1) continue;
      const info = db.prepare(`PRAGMA index_info('${ix.name}')`).all();
      if (info.length === 3) legacy = true;
    }
    if (legacy) {
      // 迁移期临时关闭外键：结构搬运，避免依赖其他表已就绪
      db.pragma('foreign_keys = OFF');
      db.exec('BEGIN');
      db.exec('ALTER TABLE confirmations RENAME TO confirmations_old');
      db.exec(
        `CREATE TABLE confirmations (
          id            INTEGER PRIMARY KEY,
          rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
          role_id       INTEGER NOT NULL REFERENCES roles(id),
          actor_id      INTEGER NOT NULL REFERENCES users(id),
          scene_id      INTEGER NOT NULL REFERENCES scenes(id),
          content_hash  TEXT NOT NULL,
          confirmed_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (rehearsal_id, role_id, scene_id, actor_id)
        )`
      );
      db.exec(
        `INSERT INTO confirmations
           (id, rehearsal_id, role_id, actor_id, scene_id, content_hash, confirmed_at)
         SELECT id, rehearsal_id, role_id, actor_id, scene_id, content_hash, confirmed_at
           FROM confirmations_old`
      );
      db.exec('DROP TABLE confirmations_old');
      db.exec('COMMIT');
      db.pragma('foreign_keys = ON');
    }
    db.pragma('user_version = 2');
  }
  if (from < 3) {
    // 已有批次说明不是从 v2 升级（或已补过），跳过补建
    const hasBatches = db.prepare('SELECT COUNT(*) AS n FROM schedule_notifications').get().n > 0;
    if (!hasBatches) {
      db.exec('BEGIN');
      // 每个有效时段补一个“创建”批次，冻结当前 UTC 时段/场次/固定版本
      db.exec(`INSERT INTO schedule_notifications
                 (schedule_id, rehearsal_id, scene_id, version_id, start_at, end_at, reason, created_by)
               SELECT s.id, s.rehearsal_id, s.scene_id, r.version_id, s.start_at, s.end_at, 'create', s.created_by
                 FROM rehearsal_schedules s
                 JOIN rehearsals r ON r.id = s.rehearsal_id
                WHERE s.status = 'active'`);
      // 收件人 = 该排练当前固定版本中本场有台词且已派角的演员（一人多角合并为 roles_json）
      db.exec(`INSERT INTO schedule_notification_recipients (notification_id, actor_id, roles_json)
               SELECT n.id, c.actor_id,
                      json_group_array(json_object('roleId', ro.id, 'roleCode', ro.code, 'roleName', ro.name))
                 FROM schedule_notifications n
                 JOIN rehearsals r ON r.id = n.rehearsal_id
                 JOIN (SELECT DISTINCT version_id, scene_id, role_id FROM version_lines) vl
                   ON vl.version_id = r.version_id AND vl.scene_id = n.scene_id
                 JOIN rehearsal_cast c ON c.rehearsal_id = r.id AND c.role_id = vl.role_id
                 JOIN roles ro ON ro.id = vl.role_id
                GROUP BY n.id, c.actor_id`);
      db.exec('COMMIT');
    }
    db.pragma('user_version = 3');
  }
}
migrate();

/**
 * 在事务中执行 fn；fn 抛错则整体回滚。
 * better-sqlite3 的事务是同步的，直接包装即可。
 */
function transaction(fn) {
  return db.transaction(fn)();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(password), salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 某版本中“角色 × 场次”台词文本的指纹：用于换版后判定是否必须重新确认 */
function roleSceneHash(versionId, roleId, sceneId) {
  const rows = db
    .prepare(
      `SELECT seq, text FROM version_lines
        WHERE version_id = ? AND role_id = ? AND scene_id = ?
        ORDER BY seq, id`
    )
    .all(versionId, roleId, sceneId);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

module.exports = { db, transaction, hashPassword, verifyPassword, roleSceneHash, DB_PATH };
