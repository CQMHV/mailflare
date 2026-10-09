# 手动 R2 快照和隔离恢复

这是临时在本机运行的工具。它把 `mailflare-raw` 的**整桶对象**复制到独立私有桶 `mailflare-backups`，不删除或修改源对象。不要部署此 Worker、添加路由、绑定公开域名或启用 `r2.dev`。完成后关闭本机 Wrangler 进程即可，没有常驻公开服务，也不会创建定时任务。

快照布局：

```text
snapshots/<id>/manifest.json
snapshots/<id>/objects/<SHA256(原始 key 的 UTF-8 字节)>
```

manifest 保存原始 key、内容 SHA256、字节数、HTTP/custom metadata、源版本与上传时间。哈希路径避免中文、斜杠、冒号等 key 在本机文件系统中的问题。只有全部对象复制成功、逐一读回校验后，manifest 才标记 `completed`；`failed` / `in_progress` 均拒绝恢复。快照 ID 不能覆盖，未完成对象也不会被自动删除。

## 前提

- 在正确 Cloudflare 账户中，两个远程桶已存在且都保持私有：`mailflare-raw`、`mailflare-backups`。本工具不创建桶。
- 使用已授权的 Wrangler 登录状态。`SOURCE`/`BACKUP` 的 `remote: true` 使用 Wrangler 的 Cloudflare 授权访问真实 R2，不需要另配 S3 Access Key。OAuth 权限需包含 R2；账户/桶访问不足时操作会失败。本工具没有 token 参数，不保存或输出凭据，也不记录提供商的原始错误。
- `TARGET` 默认 `remote: false`，是本机持久化的隔离 R2 `mailflare-restore-test`，不会在 Cloudflare 上创建同名桶。它必须为空。程序同时拒绝 `mailflare-raw`、`mailflare-backups` 以及配置中的源/备份桶作为恢复目标。
- 快照期间暂停永久删信、附件清理、备份过期清理以及修改已有对象。整桶分页与 D1 导出不是共同事务；新增邮件可能在快照开始后出现。需要一致的迁移恢复点时，短暂暂停写入，先导出 D1，再做本工具快照，并在恢复验证前核对 D1 中的 R2 引用都存在。不要在业务仍写入时把结果解释成某一瞬间的数据库快照。

## 启动（仓库根目录，第一个终端）

```powershell
npx wrangler dev --config scripts/r2-snapshot/wrangler.jsonc --ip 127.0.0.1 --port 8799 --persist-to .wrangler/r2-snapshot-test
```

此配置独立于主 Mailflare Worker，没有 Queue、Cron、邮件收件或发件绑定。不要加 `--local`，它会禁用 SOURCE/BACKUP 的远程访问；也不要使用 `--remote`，工具应在本机执行。检查启动信息：SOURCE/BACKUP 为 remote，TARGET 为 local，监听地址为 `127.0.0.1`。如果安装依赖以外的命令提示部署、创建资源或选择未知账户，先停止并核实。

## 快照与恢复验证（第二个终端）

选择一个新的、可识别的 ID（只允许字母、数字、`_`、`-`，最多 100 字符），并保留它：

```powershell
node scripts/r2-snapshot/cli.mjs backup --id pre-deploy-20261009
node scripts/r2-snapshot/cli.mjs inspect --id pre-deploy-20261009
node scripts/r2-snapshot/cli.mjs restore --id pre-deploy-20261009
node scripts/r2-snapshot/cli.mjs verify --id pre-deploy-20261009
```

也可以不传 backup 的 `--id`，CLI 会生成并在请求前打印 ID。`inspect` 显示状态、数量、大小和 manifest 路径，不输出邮件内容或元数据。`restore` 默认写入本机隔离桶；`verify` 逐一读取 TARGET，确认对象集合、内容 SHA256/大小和元数据与 manifest 一致。预期结果为 `status: completed`、`restored: true`、`verified: true`。

同一 dev 进程每次只接受一个操作，拒绝浏览器 Origin 和公开 hostname，没有 CORS。CLI 只连接无凭据的 HTTP loopback URL。可以用 `--url http://127.0.0.1:8799` 指定本机端口。

恢复失败可能留下部分**隔离**目标，程序不会删除或覆盖它。先检查错误与快照，再停掉 dev 进程，选择新的本机 `--persist-to` 目录，重新启动并恢复；不要为了重试清空正式桶。网络断开或超时属于结果未知，使用原 ID `inspect` 核实，不要盲目重新创建快照。`failed` / `in_progress` 快照保留用于排查，重新备份使用新 ID。

## 用于完整 Mailflare 恢复演练

这个工具验证 R2 对象可还原，但不能单独证明 Mailflare 完整恢复：

1. 保存 Mailflare 的全量 D1 JSON 备份，确认所需数据表都被包含；D1 里的 `raw_r2_key` / 附件 key 只是引用，D1 原生恢复不包含 R2 对象。
2. 在空的隔离 D1 中应用同一版本迁移并恢复 JSON。隔离应用不能绑定正式 Queue/Cron/Email Sending，也不要修改正式 Email Routing 或 DNS。
3. 使用上述命令恢复到本机 TARGET。核对隔离 D1 引用的原始 MIME、附件、网盘和头像 key，打开至少一封含附件的邮件并下载对比内容；检查用户、域名、邮箱、草稿和设置。
4. 记录快照 ID、应用版本、D1 备份文件及校验值、R2 verify 结果。Worker 配置和 Secrets 需另行安全保存，不能通过 R2/D1 快照恢复。

下载全量 D1 JSON 和对应快照的完整 `manifest.json` 后，可以先用下列**纯本机**脚本验证数据库恢复；传入的 `--out` 必须是尚不存在的目录（父目录需已存在）：

```powershell
node scripts/r2-snapshot/verify-database.mjs --backup "C:\path\mailflare.json" --manifest "C:\path\manifest.json" --out "C:\path\new-isolated-restore"
```

脚本需要 Node 24 和仓库已安装的 esbuild。它把全部迁移应用到新 SQLite，复用实际 `restoreDatabaseRecords`，检查 includedTables 行数、外键和 SQLite 完整性；从当前 schema 找出 `raw_r2_key`、`r2_key`、`avatar_key`、`icon_key`，加上网盘文件的旧版默认 key，确认这些引用都在 completed manifest 的原始 key 集合中。进行中的网盘上传不被豁免，有缺失引用会失败并报告上传数量，以便决定是否先完成上传。

输出目录只含 `restored.sqlite` 与 `verification-report.json`。报告和终端输出只有计数、文件 SHA256 与缺失引用统计，不输出原 key、邮箱内容、密码 hash 或 session token；SQLite 本身保存完整恢复数据。已有目录/数据库不会覆盖，失败结果也保留在隔离目录中。`verified: true` 且退出码 0 表示数据库检查通过，R2 内容与元数据仍需配合上面的 `restore`/`verify` 命令校验。旧全量备份缺少后来新增的表时继续使用现有兼容规则，报告 `currentTablesNotIncluded`；这不能证明备份包含这些表的数据。

## 范围与限制

- 对象按顺序处理，内容通过流计算哈希。为保留 R2 body 的已知长度并检查源版本，读取源两次：第一次算 SHA256，第二次同 ETag/版本条件读取并复制，上传带原生 SHA256 校验，再读回核对。不会将整个对象放进内存。
- 使用 R2 单次 `put`，单对象最多 5 GiB − 5 MiB（官方精确上限）。超过上限会明确失败并保留非 completed 状态，绝不跳过；大网盘对象需要另行增加 multipart 支持后再做完整备份。manifest 两次写入间隔至少 1.1 秒，遵守 R2 同一 key 的写入速率限制。
- 清单在内存中积累，适合本任务的个人邮箱规模，不是海量数据搬迁服务。未完成的 multipart upload 没有形成完整对象，不包含在快照中；SSE-C 对象没有提供密钥时无法复制。恢复使用默认 Standard 存储类，原对象上传时间/version/etag 不能原样恢复，HTTP/custom metadata 会恢复。
- 两个桶位于同一 Cloudflare 账户，独立桶能隔离业务删除与损坏；它不能防止整个账户被删除或被拥有两个桶权限的人破坏。之后可再决定跨账户/离线副本与保留策略。现在不自动清理快照、不配置自动化。

## 本机验证

```powershell
node --test scripts/r2-snapshot/r2-snapshot.test.mjs
node --test scripts/r2-snapshot/verify-database.test.mjs
npx eslint scripts/r2-snapshot/worker.ts scripts/r2-snapshot/cli.mjs scripts/r2-snapshot/r2-snapshot.test.mjs
```

测试包括模拟原生 R2 的分页、条件、流、校验和元数据行为，也在实际本机 workerd/Miniflare R2 上跑完整备份→恢复→verify；它们不访问正式远程资源。

官方参考：[远程 binding](https://developers.cloudflare.com/workers/local-development/#remote-bindings)、[原生 R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[R2 凭据](https://developers.cloudflare.com/r2/api/tokens/)、[R2 限制](https://developers.cloudflare.com/r2/platform/limits/)。
