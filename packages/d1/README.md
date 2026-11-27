# @larkflare/d1

[![npm](https://img.shields.io/npm/v/%40larkflare%2Fd1.svg)](https://www.npmjs.com/package/@larkflare/d1)
[![CI](https://github.com/ztxtxwd/larkflare/actions/workflows/ci.yml/badge.svg)](https://github.com/ztxtxwd/larkflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Larkflare D1：飞书多维表格上的关系型 SQL 数据库。**

Larkflare DB 是 NoSQL 文档引擎；D1 是独立的**关系型**产品：它用 `CREATE TABLE` 声明列、类型、主键与唯一约束，用 SQL 读写行，并把数据落到 DB 管理的 Bitable 表里。API 形状对标 Cloudflare D1：`prepare` / `bind` / `all` / `first` / `run` / `raw` / `batch` / `exec` / `dump`。

```bash
pnpm add @larkflare/d1 @larkflare/db
```

## 快速开始

```ts
import { createD1 } from '@larkflare/d1'

const d1 = createD1({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
})

const db = d1.database('app')

await db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    age INTEGER,
    active BOOLEAN DEFAULT TRUE,
    profile JSON
  )
`)

const inserted = await db
  .prepare('INSERT INTO users (email, name, age, profile) VALUES (?, ?, ?, ?)')
  .bind('ada@example.com', 'Ada', 36, { lang: 'en' })
  .run()

console.log(inserted.meta.last_row_id) // 1

const { results } = await db
  .prepare('SELECT id, name, age FROM users WHERE age >= ? ORDER BY age DESC LIMIT ?')
  .bind(18, 10)
  .all()

console.log(results)
```

## API

### `createD1(options): D1`

`D1Options` 继承 `LarkflareConfig`（`appId` / `appSecret` / `accessToken` / `domain` / 限流与重试等），并额外接受：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `client` | — | 复用已有 `Larkflare`（DB 客户端），不再创建新连接 |
| `pageSize` | `500` | 扫表时每页读取的 Bitable 行数 |

`D1`

| 成员 | 说明 |
| --- | --- |
| `database(name)` / `useDatabase(name)` | 取数据库句柄；Base 在首次操作时创建 / 接管 |
| `listDatabases()` | 列出共享 DB 目录中的数据库 |
| `close()` | flush 并关闭底层 DB 客户端 |

### `D1Database`

| 方法 | 说明 |
| --- | --- |
| `prepare(sql)` | 解析单条 SQL，返回 `D1PreparedStatement` |
| `exec(sql)` | 执行分号分隔的多条语句，返回 `{ count, duration }` |
| `batch(statements)` | 顺序执行多个 prepared statement，返回每个结果 |
| `dump()` | 导出 schema + 数据为 SQLite 风格的 SQL 文本（`ArrayBuffer`） |
| `listTables()` | 列出 SQL 表、列定义与行数 |

### `D1PreparedStatement`

| 方法 | 说明 |
| --- | --- |
| `bind(...values)` | 绑定 `?` 参数；返回新 statement，可反复复用 |
| `all<T>()` | 返回 `{ success, results, meta }` |
| `first<T>(column?)` | 返回第一行（或某一列），无行为 `null` |
| `run<T>()` | 执行并返回结果 |
| `raw<T>({ columnNames? })` | 返回按列顺序排列的数组；可把列名作为首行 |

`meta`：`duration`、`changes`、`last_row_id`、`changed_db`、`rows_read`、`rows_written`。

## 支持的 SQL

- **DDL**：`CREATE TABLE [IF NOT EXISTS]`、`DROP TABLE [IF EXISTS]`。
  列约束支持 `PRIMARY KEY`、`AUTOINCREMENT`（仅 `INTEGER PRIMARY KEY`）、`NOT NULL`、`UNIQUE`、`DEFAULT <literal>`、`REFERENCES table(column)`（RESTRICT 外键）。
- **DML**：`INSERT INTO ... VALUES (...)`（多行）、`UPDATE ... SET ... [WHERE]`、`DELETE FROM ... [WHERE]`。
- **查询**：`SELECT [DISTINCT] ... FROM ... [WHERE] [GROUP BY ...] [HAVING ...] [ORDER BY] [LIMIT [OFFSET]]`。
- **连接**：`[INNER] JOIN`、`LEFT [OUTER] JOIN`、`CROSS JOIN`，支持 `AS` 别名与 `table.column` 限定引用；`ON` 里不能有聚合。
- **表达式**：`AND` / `OR` / `NOT`、`= != <> < <= > >=`、`IN`、`LIKE`、`IS [NOT] NULL`、`+ - * / %`、`||`、括号、`?` 参数。
- **聚合**：`COUNT(*)`、`COUNT(col)`、`SUM`、`AVG`、`MIN`、`MAX`，支持 `GROUP BY` / `HAVING`，允许与算术组合，例如 `SUM(amount) / COUNT(*)`。`ORDER BY` 可以使用真实列、`SELECT` 别名或聚合表达式。
- **类型**：`INTEGER`、`REAL`、`NUMERIC`、`TEXT`、`BLOB`、`BOOLEAN`、`JSON`（后两者是 Larkflare 扩展）。

不支持的语法（会明确报错，而不是静默降级）：`RIGHT` / `FULL` / `NATURAL JOIN`、`USING`、`ON DELETE` / `ON UPDATE` 动作、子查询、`UNION`、`ALTER TABLE`、`CREATE INDEX`、`RETURNING`、事务（`BEGIN` / `COMMIT` / `ROLLBACK`）。

## 数据映射

| 概念 | 飞书侧 |
| --- | --- |
| D1 数据库 `app` | DB 数据库 Base `larkflare:app` |
| SQL 表 `users` | Base 中的 DB 表 `users`（自动分片） |
| 行 | Bitable 记录 |
| 列 | Bitable 字段（整数 / 数字 / 文本 / 复选框 / 附件 / JSON） |
| 自增 rowid | 隐藏数字列 `__rowid`，映射为 `meta.last_row_id` |
| schema 目录 | 保留表 `__d1_schema` |

表名与列名大小写不敏感；保留字需要用双引号包起来，例如 `"order"`。`_id` 与 `__rowid` 是保留列名。D1 与 DB / Vectorize / R2 共用 `larkflare:` 数据库命名空间：一个 D1 数据库就是同名的 DB 数据库 Base，额外维护 `__d1_schema` 表。

## 约束与边界

- **没有事务**：`batch()` 只是顺序执行；中途失败不会回滚已完成语句。Bitable 本身也不提供事务。
- **约束是尽力而为的**：`PRIMARY KEY` / `UNIQUE` 在写入前查询现有行并在进程内比较，并发写者仍可能破坏唯一性；`AUTOINCREMENT` 取当前最大 rowid + 1，不是持久化序列。
- **查询会扫表**：简单比较、`AND`、`IN`、`IS NULL` 会下推成 Bitable 过滤条件；`LIKE`、`OR`、表达式等由进程内求值。`ORDER BY` 与 `LIMIT` 在内存中完成，大表请尽量用可下推的等值条件。
- **ORDER BY 支持别名与聚合**：`ORDER BY` 可以引用真实列、`SELECT` 别名或聚合表达式；`GROUP BY` / `HAVING` 与聚合都在进程内对过滤后的行计算，不会下推到 Bitable。
- **JOIN 是嵌套循环**：参与连接的表会被完整读取，`ON` 条件不会下推到 Bitable；只适合中小结果集。同名列必须用 `alias.column` 限定，否则会报 ambiguous。
- **不是完整 SQLite**：没有查询优化器、索引和事务；复杂查询请先在小表上验证扫描代价。
- **类型严格**：整数列拒绝小数，布尔列只接受布尔 / 0 / 1 / `"true"` / `"false"`，`TEXT` 会把数字与布尔转成字符串。`BLOB` 接受 `Buffer` / `Uint8Array` / `ArrayBuffer` / 字符串，读回 `ArrayBuffer`。
- **外键是 RESTRICT**：`REFERENCES` 的目标表必须在创建时已存在（自引用除外），目标列必须是 `PRIMARY KEY` 或 `UNIQUE`。插入 / 更新子行会检查父行存在；删除 / 更新父键时，如果还有子行引用会直接报错。没有 `CASCADE` / `SET NULL`，也不支持延迟约束。自引用表按 `VALUES` 顺序逐行插入，父行必须写在子行前面。
- **BLOB 存在飞书云盘**：由 DB 的附件能力上传，行里只存 `file_token`。`SELECT *` 或 `dump()` 会下载匹配到的 BLOB 正文，大对象请按需选列。
- **Bitable 限额**：单表约 20,000 行（DB 自动分片），单次批量 1,000 条，单次搜索 500 条。D1 会分页读取，但大结果集仍然较慢。
- **多进程**：schema 目录缓存与唯一性检查都是进程内状态；并发 DDL 可能产生重复元数据。同一个数据库建议单写入者。

## 飞书应用权限

与 DB 相同：`bitable:app`（多维表格读写与附件素材）和 `space:document:retrieve`（按名称发现并接管已有 Base）。使用 BLOB 列时附件上传/下载也由 `bitable:app` 覆盖。

## License

MIT
