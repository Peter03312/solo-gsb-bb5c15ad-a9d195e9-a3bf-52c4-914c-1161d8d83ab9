# 剧团排练台词（Rehearsal Lines）

一个用 **Node.js + Express + SQLite（better-sqlite3）** 实现的剧团排练台词管理网页应用。

- **导演**：维护剧本的场次、角色、台词顺序；以“修订”的方式改词并发布版本。
- **演员**：登录后只能看到自己被分配角色的排练稿，按场次逐场确认。

## 核心业务规则

### 版本与发布（不可改写）

1. 新建剧本是**草稿**，导演可直接录入台词；发布**首版**后，现行文本冻结。
2. 首版之后的任何文本改动都必须走**修订**：
   - 修订必须**以某个已发布版本为基准**（可基于旧版）；
   - 每条改动必须标明被改台词的**原文**与**新文**（删除只需原文，新增指定场次/角色/新文）；
   - 提交时即校验原文与基准版本逐字一致，不一致直接拒绝（`OLD_TEXT_MISMATCH`）。
3. **发布**时可勾选多个互不冲突的修订，系统逐条核对“修订声称的原文”与“现行（最新已发布）文本”：
   - 原文已被其他修订/新版改动 → 冲突 `text_changed`；
   - 台词已在现行版本中删除 → 冲突 `line_deleted`；
   - 同批次两个修订改了同一句且结果不同 → 冲突 `batch_cross_edit`；
   - **只要存在冲突，本次发布整体不生效**，不会产生新版本，修订保持“进行中”；
   - 互不冲突的修订（含内容完全相同的幂等改动）可合入同一个新版本。
4. 每次发布尝试（成功或因冲突失败）都留有记录和冲突详情。
5. `versions` 与 `version_lines` 是只增不改的快照，数据库触发器禁止 `UPDATE/DELETE`。

### 排练、派角与确认

1. 创建排练时**必须固定引用一个版本**；之后不会自动跟随新版本。
2. **换版必须显式操作**（选择目标版本），并记录换版历史。
3. 换版后，只有“角色 × 场次”台词内容发生变化的确认会作废，需要该角色重新确认；文本未变的确认继续有效。
4. 演员只能对**自己获分配角色**的场次确认；角色**改派**后，原演员的历史确认保留但不再计入，新演员需逐场重新确认。
5. 导演页面和总览页显示每个排练的**待确认演员/角色/场次及原因**，以及最近的发布冲突详情。
6. 演员的剧本、版本、排练稿接口均只返回其所派角色的台词；越权访问、无效版本/场次会得到明确的 `403/400/404`。

### 排练日程（带时区时段）

1. 导演可为已有排练的**某场次**安排**多段**带时区的起止时间
   （ISO 8601 且必须带时区，如 `2026-10-03T14:00:00+08:00` 或 `...Z`；服务端归一化为 UTC 存储与返回）。
2. 时段的**参与者** = 该排练**当前固定版本**中本场次有台词**且已派角**的演员（动态计算）；
   有台词但**未派角**的角色列为**待补派**，不阻止安排。
3. 场次必须属于该剧且在当前固定版本中有台词；**结束必须晚于开始**。
4. **保存/调整时段、派角/改派、换版**时，若参与演员与其他**未取消**时段（待调整不计入）重叠，
   **整次操作拒绝**并返回冲突演员与时段（`409 SCHEDULE_CONFLICT`，`details.conflicts` 含演员与双方时段）；
   **端点相接**（如 10:00–11:00 与 11:00–12:00）**不算重叠**；失败的换版不会改变版本与确认。
5. 换版后，场次在新版本中已无台词的既有安排标为**待调整**（不参与冲突检测）；
   导演调整其时段/场次（须通过第 3 条校验）后恢复有效。
6. 导演可**取消**安排，并查看待补派、待调整与已取消的安排（`?status=` 可过滤）；
   演员只能看到**自己当前参与的有效时段**。

### 演员不可用时段

1. 演员可**登记、修改、撤销**自己的不可用时段：输入**带时区**的起止时间（ISO 8601，如
   `2026-10-03T14:00:00+08:00` 或 `...Z`）与**原因**；服务端归一化为 **UTC** 保存，
   **结束必须晚于开始**，**端点相接不算重叠**（半开区间 `[start, end)`）。
2. 演员**提交或修改**时，若与本人**当前参与的有效排练日程**重叠，**整次拒绝**并在
   `details.conflicts` 中指出冲突日程（`409 UNAVAILABILITY_CONFLICT`）。
3. 导演**安排/调整日程、派角/改派、显式换版**时，同样检查受影响演员的不可用时段：
   一旦相撞，**整次操作不生效**，`details.conflicts` 返回**演员、日程及不可用时段**；
   **已取消和待调整日程不参与**检测；已有日程之间的互撞仍按现有 `409 SCHEDULE_CONFLICT` 处理。
4. 开启过的**到场登记名单与签到不因不可用时段变化而改写**（登记仍是开启时的冻结快照）。
5. 演员可查看**本人**不可用记录（接口仅对演员开放）；导演在排期冲突响应中看到必要的
   演员/日程/不可用时段信息。

### 到场登记（按时段一次性签到）

1. 导演可为**有效**（`active`）日程时段**开启一次**到场登记；已取消、待调整或已有登记
   （含已关闭/已作废）的时段不得开启（重复开启返回 `409 ATTENDANCE_EXISTS`）。
2. **开启即冻结**：场次、UTC 起止时段、排练当时固定版本，以及当时“本场次有台词且已派角”
   的演员名单；有台词但**未派角**的角色记为**缺口**，仅展示、**不计应到**。
3. **签到**：仅名单内演员本人在开放期签到（首次 `201`）；**重试返回首次签到结果**
   （`200`，`alreadyCheckedIn: true`，`checkedInAt` 为首次时间）；名单外演员（含开启后才派角的
   **后来加入者**）与导演签到均 `403`。
4. **关闭**：仅导演、仅开放中的登记；关闭后未签到者记**缺席**，后续签到
   （`409 ATTENDANCE_NOT_OPEN`）与再次关闭（`400`）均拒绝。
5. **不回写**：开启后的改派、换版、调整日程均不回写名单与签到——名单、缺口、冻结版本与
   UTC 时段保持开启时快照；原演员被改派后仍在冻结名单内，仍可签到。
6. **日程取消联动**：
   - 开放期取消日程 → 登记**作废**（`voided`）：停止签到，已签到痕迹保留但**不计出勤**；
   - 关闭后取消日程 → 仅标注 `scheduleCancelled`，原统计保留。
7. **可见性**：导演查看名单、缺口与状态统计（应到/已签到/待签到或缺席/是否计入出勤）；
   演员只看本人记录（不在名单上 `403`）。导演与演员的日程列表均带 `attendance` 摘要字段。

## 一键启动（Docker，推荐）

前置：已安装 Docker 与 Docker Compose v2。

```bash
docker compose up --build -d
```

启动后：

- 访问地址：<http://localhost:3000>
- 健康检查：<http://localhost:3000/api/health>
- SQLite 数据库保存在命名卷 `rehearsal-data`（容器内 `/data/app.db`），首次启动自动建表并写入演示数据。

停止 / 清除数据：

```bash
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除数据库卷（下次启动重新初始化）
```

查看日志：

```bash
docker compose logs -f
```

> 镜像构建时优先使用 better-sqlite3 的预编译二进制；若构建机无法从 GitHub Release 下载，
> 构建阶段已内置 `python3/make/g++` 工具链会自动改为源码编译。也可用构建参数
> `--build-arg` 配合环境变量 `BETTER_SQLITE3_BINARY_URL`（指向离线 tar 包）加速离线构建。

## 本地直接运行（Node 20+）

```bash
npm install        # 安装依赖（必要时自动拉取 better-sqlite3 预编译包）
npm start          # 默认监听 0.0.0.0:3000
```

浏览器打开 <http://localhost:3000>。首次启动在 `./data/app.db` 自动建表并初始化演示数据；
删除 `data/` 目录即可回到全新状态。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口（Compose 已映射宿主机 `3000:3000`） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | SQLite 数据库目录（Docker 中为 `/data`） |
| `DB_PATH` | `$DATA_DIR/app.db` | 可直接指定数据库文件完整路径 |
| `BETTER_SQLITE3_BINARY_URL` | 空 | 安装依赖时 better-sqlite3 预编译包的自定义/离线下载地址 |

修改端口示例：

```bash
PORT=8080 docker compose up --build -d
# 同时把 docker-compose.yml 的端口映射改为 "8080:8080"
```

## 演示账号

| 角色 | 用户名 | 密码 | 说明 |
| --- | --- | --- | --- |
| 导演 | `director` | `director123` | 维护剧本、修订发布、创建排练、派角 |
| 演员 | `lin` | `actor123` | 林晚，饰演《夜航灯塔》守塔人 |
| 演员 | `chen` | `actor123` | 陈默，饰演船员 |
| 演员 | `zhou` | `actor123` | 周海，初始未派角 |

演示数据包含剧本《夜航灯塔》（2 个场次、2 个角色、7 句台词，已发布 v1）和一个固定 v1 的排练
（含一段 2026-10-10 的示例日程）。

## 页面与操作路径

- **导演 → 剧本与版本**：建剧本、加场次/角色、录入草稿台词、发布首版、查看各版本快照。
- **导演 → 修订发布**：选基准版本建修订、逐条添加改/增/删（界面可一键填入所选台词原文）、
  勾选多个修订发布；冲突时页面展示每处冲突的“修订声称原文 vs 现行文本”，并可在发布记录中回看。
- **导演 → 排练与确认**：创建固定版本的排练、显式换版、派角/改派，查看待确认清单与冲突；
  为场次安排/调整/取消带时区的排练时段，查看参与者与待补派；对有效时段**开启/查看/关闭到场登记**
  （名单、缺口、应到/签到/缺席统计）。排期/调期/派角/换版若撞上演员不可用时段，
  页面会提示冲突演员及其不可用时段与原因。
- **导演 → 总览**：所有排练的待确认汇总与最近冲突详情。
- **演员**：进入排练后仅显示本人角色台词，按场次点“确认本场台词”；换版或改派后相应场次会回到待确认；
  可查看自己当前参与的排练时段，并在登记开放期为本人**到场签到**；
  在“我的不可用时段”中**登记/修改/撤销**不可用时间（与本人有效日程重叠会被整次拒绝并指出冲突日程）。

## HTTP API 摘要（均返回 JSON，会话用 Cookie 或 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` · `/api/logout` | 登录 / 退出 |
| GET | `/api/me` | 当前用户 |
| POST/GET | `/api/plays` | 建剧本（导演）/ 剧本列表（演员仅见参演剧本） |
| GET | `/api/plays/:id` | 剧本结构与现行台词（演员只返回所派角色） |
| POST | `/api/plays/:id/scenes` `/roles` `/lines` | 草稿期维护 |
| POST | `/api/plays/:id/publish-initial` | 发布首版 |
| GET | `/api/plays/:id/versions` · `/api/versions/:vid` | 版本列表 / 版本快照 |
| POST/GET | `/api/plays/:id/revisions` | 建修订 / 列表 |
| POST | `/api/revisions/:id/items` | 添加修订条目（校验原文） |
| POST | `/api/revisions/:id/abandon` | 作废修订 |
| POST | `/api/plays/:id/publish` | 发布（冲突返回 409 且不生效） |
| GET | `/api/plays/:id/publish-attempts` | 发布记录与冲突详情 |
| POST/GET | `/api/plays/:id/rehearsals` · `/api/rehearsals` | 建排练 / 列表 |
| GET | `/api/rehearsals/:id` | 派角、待确认、换版历史、最近冲突 |
| POST | `/api/rehearsals/:id/switch-version` | 显式换版 |
| POST/DELETE | `/api/rehearsals/:id/cast[/:roleId]` | 派角/改派/取消 |
| GET | `/api/rehearsals/:id/script` | 演员排练稿（仅本人角色） |
| POST | `/api/rehearsals/:id/confirm` | 演员逐场确认 |
| POST/GET | `/api/rehearsals/:id/schedules` | 安排时段（导演）/ 日程列表（导演含待补派·待调整·已取消，`?status=` 可过滤；演员仅自己参与的有效时段） |
| PATCH | `/api/rehearsals/:id/schedules/:sid` | 调整时段/场次（导演；待调整的时段借此恢复有效） |
| POST | `/api/rehearsals/:id/schedules/:sid/cancel` | 取消时段（导演，记录保留可查；联动到场登记见下） |
| POST | `/api/rehearsals/:id/schedules/:sid/attendance` | 开启到场登记（导演；冻结名单/缺口/版本/UTC 时段，每时段至多一次） |
| POST | `/api/rehearsals/:id/schedules/:sid/attendance/close` | 关闭登记（导演；未签到者记缺席） |
| POST | `/api/rehearsals/:id/schedules/:sid/attendance/check-in` | 演员本人签到（开放期+名单内；重试返回首次结果） |
| GET | `/api/rehearsals/:id/schedules/:sid/attendance` | 登记详情（导演：名单/缺口/统计；演员：仅本人记录） |
| GET/POST | `/api/me/unavailability` | 演员查看 / 登记本人不可用时段（带时区起止+原因，UTC 保存；撞本人有效日程 409） |
| PATCH/DELETE | `/api/me/unavailability/:id` | 演员修改 / 撤销本人不可用时段（修改同样做重叠校验） |
| GET | `/api/dashboard` | 导演总览 |

错误统一形如 `{ "error": "CODE", "message": "...", "details": ... }`，
典型状态码：`400`（无效版本/场次/参数、状态不允许的操作）、`401`（未登录）、`403`（越权）、`404`（不存在）、
`409`（业务冲突，如 `OLD_TEXT_MISMATCH`、`PUBLISH_CONFLICT`、`SCHEDULE_CONFLICT`、
`UNAVAILABILITY_CONFLICT`、`ATTENDANCE_EXISTS`、`ATTENDANCE_NOT_OPEN`）。

## 日程接口调用示例（curl）

```bash
# 1. 导演登录，拿到 token
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"director","password":"director123"}'
# -> {"token":"<TOKEN>","expiresAt":"...","user":{...}}

# 2. 为排练 1 的场次 1 安排带时区时段（+08:00 14:00–15:30）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"sceneId":1,"startAt":"2026-10-03T14:00:00+08:00","endAt":"2026-10-03T15:30:00+08:00"}'
# -> 201 {"schedule":{"id":2,"status":"active","startAt":"2026-10-03T06:00:00.000Z",
#        "participants":[{"actorId":2,"actorName":"林晚","roles":[...]}, ...],
#        "pendingCast":[], ...}}
#    时间归一化为 UTC 返回；participants=当前版本本场有台词且已派角的演员，
#    有台词未派角的角色出现在 pendingCast（待补派），不阻止安排。

# 3. 与其他未取消时段重叠 -> 整次拒绝（端点相接不算重叠）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"sceneId":2,"startAt":"2026-10-03T15:00:00+08:00","endAt":"2026-10-03T16:00:00+08:00"}'
# -> 409 {"error":"SCHEDULE_CONFLICT","message":"参与演员与其他未取消时段重叠，本次操作未生效",
#        "details":{"conflicts":[{"actorId":2,"actorName":"林晚",
#          "schedule":{"id":null,"sceneId":2,"startAt":"...","endAt":"..."},
#          "overlapsWith":{"id":2,"rehearsalId":1,"sceneId":1,"startAt":"...","endAt":"..."}}]}}

# 4. 导演查看全部日程（含待补派/待调整/已取消；?status=needs_adjustment 可过滤）
curl -s "http://localhost:3000/api/rehearsals/1/schedules" \
  -H "Authorization: Bearer <TOKEN>"
curl -s "http://localhost:3000/api/rehearsals/1/schedules?status=cancelled" \
  -H "Authorization: Bearer <TOKEN>"

# 5. 调整时段（可改场次/起止；待调整的时段调整合法后恢复有效）
curl -s -X PATCH http://localhost:3000/api/rehearsals/1/schedules/2 \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"startAt":"2026-10-04T14:00:00+08:00","endAt":"2026-10-04T15:00:00+08:00"}'

# 6. 取消时段（记录保留，导演列表中可见“已取消”）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/2/cancel \
  -H "Authorization: Bearer <TOKEN>"

# 7. 演员查看日程：只有自己当前参与的有效时段
curl -s "http://localhost:3000/api/rehearsals/1/schedules" \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> {"schedules":[{"id":3,"sceneCode":"I","sceneTitle":"风暴前夜",
#      "startAt":"...","endAt":"...","status":"active","myRoles":[{"roleId":1,"roleName":"守塔人"}]}]}
```

派角/改派（`POST /api/rehearsals/:id/cast`）与显式换版（`POST /api/rehearsals/:id/switch-version`）
同样做日程冲突校验：若新的参与演员与其他未取消时段重叠，返回 `409 SCHEDULE_CONFLICT` 且整次操作不生效
（换版失败时版本与确认均不变）；换版成功时响应新增 `needsAdjustmentSchedules`（被标为待调整的时段 id 列表）。

## 到场登记接口调用示例（curl）

```bash
# 1. 导演登录，拿到 token（演员同理：lin / actor123）
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"director","password":"director123"}'
# -> {"token":"<TOKEN>",...}

# 2. 为有效时段开启到场登记（每个时段至多一次；已取消/待调整时段 400，重复开启 409）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/1/attendance \
  -H "Authorization: Bearer <TOKEN>"
# -> 201 {"session":{"id":1,"status":"open","startAt":"2026-10-10T06:00:00.000Z",
#        "versionId":1,"versionNo":1,
#        "roster":[{"actorId":2,"actorName":"林晚","state":"pending","checkedInAt":null,...}, ...],
#        "gaps":[{"roleId":3,"roleName":"船员"}],            <- 有台词未派角，不计应到
#        "stats":{"expected":2,"checkedIn":0,"pending":2,"absent":0,"counted":true}}}
#    场次、UTC 时段、固定版本、名单与缺口在开启这一刻冻结。

# 3. 名单内演员本人签到（首次 201；重试 200 返回首次结果）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/1/attendance/check-in \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> 201 {"checkIn":{"sessionId":1,"actorId":2,"checkedInAt":"2026-10-03T04:48:12.267Z",
#        "alreadyCheckedIn":false}}
# 再次调用 -> 200 {"checkIn":{...,"checkedInAt":"<首次时间>","alreadyCheckedIn":true}}
# 名单外演员（含开启后才派角的后来加入者）-> 403

# 4. 导演查看名单、缺口与统计；演员同一接口只看本人记录
curl -s http://localhost:3000/api/rehearsals/1/schedules/1/attendance \
  -H "Authorization: Bearer <TOKEN>"
# 演员视角 -> {"session":{"id":1,"status":"open",...,"my":{"state":"checked_in",
#              "checkedInAt":"...","roles":[...]}}}（无 roster/gaps 字段；不在名单上 403）

# 5. 导演关闭登记：未签到者记缺席；此后签到 409、再次关闭 400
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/1/attendance/close \
  -H "Authorization: Bearer <TOKEN>"
# -> {"session":{"status":"closed","stats":{"expected":2,"checkedIn":1,"absent":1,...},
#        "roster":[{"actorName":"林晚","state":"checked_in",...},
#                  {"actorName":"陈默","state":"absent",...}], ...}}

# 6. 日程取消的联动（POST /api/rehearsals/1/schedules/1/cancel 之后）：
#    - 登记仍开放 -> 变为 voided：停止签到（409），已签到痕迹保留但不计出勤
#      （stats.counted=false，roster 中 checkedInAt 仍可查）；
#    - 登记已关闭 -> 仅 scheduleCancelled=true，原统计保留。

# 7. 日程列表自带登记摘要，无需逐个查询
curl -s http://localhost:3000/api/rehearsals/1/schedules -H "Authorization: Bearer <TOKEN>"
# -> {"schedules":[{"id":1,...,"attendance":{"id":1,"status":"closed","expected":2,
#        "checkedIn":1,"absent":1,"counted":true,"scheduleCancelled":true}}]}
# 演员列表中 attendance 为 {"id":1,"status":"open","myState":"pending","checkedInAt":null}
# （本人不在该次登记名单上或未开启时为 null）。
```

开启登记后的改派、换版、调整日程（`PATCH /schedules/:sid`）均**不回写**名单与签到：
登记响应中的 `versionId`、`startAt/endAt`、`roster`、`gaps` 始终保持开启时快照。

## 不可用时段接口调用示例（curl）

```bash
# 1. 演员登录，拿到 token（lin / actor123）
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"lin","password":"actor123"}'
# -> {"token":"<ACTOR_TOKEN>",...}

# 2. 登记不可用时段：带时区起止 + 原因；服务端按 UTC 保存（结束须晚于开始）
curl -s -X POST http://localhost:3000/api/me/unavailability \
  -H "Authorization: Bearer <ACTOR_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"startAt":"2026-10-12T09:00:00+08:00","endAt":"2026-10-12T12:00:00+08:00","reason":"家中有事"}'
# -> 201 {"unavailability":{"id":1,"actorId":2,
#        "startAt":"2026-10-12T01:00:00.000Z","endAt":"2026-10-12T04:00:00.000Z",
#        "reason":"家中有事",...}}
#    若与本人当前参与的有效排练日程重叠 -> 409 整次拒绝并指出冲突日程：
#    {"error":"UNAVAILABILITY_CONFLICT","message":"不可用时段与本人当前参与的有效排练日程重叠，本次操作未生效",
#     "details":{"conflicts":[{"actorId":2,"actorName":"林晚",
#        "schedule":{"id":1,"rehearsalId":1,"sceneId":1,"sceneTitle":"I 风暴前夜",
#                    "startAt":"...","endAt":"..."},
#        "unavailability":{"id":null,"startAt":"...","endAt":"...","reason":"家中有事"}}]}}
#    已取消与待调整的日程不参与；端点相接（如 12:00 接 12:00）不算重叠。

# 3. 查看本人不可用记录（仅演员本人；导演调用 403）
curl -s http://localhost:3000/api/me/unavailability \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> {"unavailability":[{"id":1,"startAt":"...","endAt":"...","reason":"家中有事",...}]}

# 4. 修改（可只改部分字段；改后与本人有效日程重叠同样 409 且原记录不变）
curl -s -X PATCH http://localhost:3000/api/me/unavailability/1 \
  -H "Authorization: Bearer <ACTOR_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"endAt":"2026-10-12T13:00:00+08:00","reason":"家中有事（改）"}'

# 5. 撤销
curl -s -X DELETE http://localhost:3000/api/me/unavailability/1 \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> {"ok":true}

# 6. 导演侧联动：安排/调整日程、派角/改派、显式换版时若撞上演员不可用时段，
#    整次操作不生效，返回演员、日程及不可用时段（409 UNAVAILABILITY_CONFLICT）：
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"sceneId":1,"startAt":"2026-10-12T10:00:00+08:00","endAt":"2026-10-12T11:00:00+08:00"}'
# -> 409 {"error":"UNAVAILABILITY_CONFLICT","message":"参与演员在该时段已登记不可用，本次安排未生效",
#        "details":{"conflicts":[{"actorId":2,"actorName":"林晚",
#          "schedule":{"id":null,"rehearsalId":1,"sceneId":1,"startAt":"...","endAt":"..."},
#          "unavailability":{"id":1,"startAt":"...","endAt":"...","reason":"家中有事"}}]}}
#    已有日程之间的互撞仍返回 409 SCHEDULE_CONFLICT，二者互不影响。
```

## 测试

端到端测试会用临时数据目录自动起停服务器，覆盖：认证与越权、修订原文校验、
多种发布冲突与幂等合并、版本快照不可改写触发器、换版后按内容变化重确认、改派后原确认失效、
日程时段校验与重叠冲突（含跨时区/端点相接/跨排练）、派角与换版的日程冲突回滚、待调整与已取消可见性、
到场登记（开启冻结名单/缺口、签到幂等、改派换版调日程不回写、关闭记缺席、开放期取消作废与关闭后取消标注、
导演/演员可见性）、演员不可用时段（登记/修改/撤销与本人可见、UTC 归一化、端点相接、
已取消与待调整不参与、与本人有效日程重叠整次拒绝、导演排期/调期/派角/换版撞不可用整次不生效、
不改写已开启的到场登记）等：

```bash
npm test
# 或：scripts/run-e2e.sh（可 TEST_PORT=xxxx 指定端口）
```

## 目录结构

```
src/
  schema.sql       数据库结构（含版本防改写触发器）
  db.js            连接、建表、轻量迁移、密码哈希、内容指纹
  seed.js          首次启动演示数据
  errors.js        统一错误
  auth.js          登录/会话/鉴权
  plays.js         剧本、场次、角色、台词、版本
  revisions.js     修订与发布（冲突检测核心）
  rehearsals.js    排练、派角、换版、逐场确认
  schedules.js     排练日程（带时区时段、参与者/待补派、重叠冲突与不可用时段检测、取消联动登记）
  attendance.js    到场登记（开启冻结名单/缺口、本人签到、关闭记缺席、作废与统计）
  unavailability.js 演员不可用时段（登记/修改/撤销/本人查看，与本人有效日程重叠即整次拒绝）
  server.js        Express 入口
public/            原生 JS 单页前端
scripts/           安装兜底脚本与端到端测试
Dockerfile, docker-compose.yml
```
