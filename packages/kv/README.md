# @larkflare/kv

[![npm](https://img.shields.io/npm/v/%40larkflare%2Fkv.svg)](https://www.npmjs.com/package/@larkflare/kv)
[![CI](https://github.com/ztxtxwd/larkflare/actions/workflows/ci.yml/badge.svg)](https://github.com/ztxtxwd/larkflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Larkflare KV：飞书多维表格上的 Workers KV 风格键值存储。**

这是 Larkflare 对标 Cloudflare Workers KV 的键值产品：命名空间是 Larkflare DB 数据库，每个 key 是 Bitable 中的一行；大文本与二进制走 DB 的云盘转储与附件上传。API 形状对标 Workers KV binding，而不是 Cloudflare REST API：`put` / `get` / `getWithMetadata` / `delete` / `list`。

为什么把 Workers KV 放到 Bitable 上？同一套飞书应用凭证、同一套 Bitable 权限，就能得到一个带命名空间、TTL、metadata、前缀与游标分页的键值存储，不需要再部署 KV、Redis 或任何外部存储。

```bash
pnpm add @larkflare/kv @larkflare/db
```

## 快速开始

```ts
import { createKV } from '@larkflare/kv'

const kv = createKV({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
})

// 命名空间在第一次操作时按需创建
const sessions = await kv.createNamespace('sessions')

await sessions.put('user:ada', JSON.stringify({ name: 'Ada' }), {
  expirationTtl: 3600,
  metadata: { role: 'admin' },
})

const text = await sessions.get('user:ada') // string | null
const json = await sessions.get('user:ada', 'json') // 解析后的 JSON | null
const bytes = await sessions.get('user:ada', 'arrayBuffer')
const stream = await sessions.get('user:ada', { type: 'stream', cacheTtl: 60 })

const { value, metadata } = await sessions.getWithMetadata('user:ada', 'json')

const page = await sessions.list({ prefix: 'user:', limit: 100 })
console.log(page.keys, page.list_complete, page.cursor)

await sessions.delete('user:ada')
```

已有 `@larkflare/db` 客户端时可以直接复用，不重复建连接：

```ts
import { createClient } from '@larkflare/db'
import { createKV } from '@larkflare/kv'

const client = createClient({ appId, appSecret })
const kv = createKV({ client, listScanLimit: 200_000 })
```

## API

### `createKV(options): KV`

`KVOptions` 继承 `LarkflareConfig`，并额外接受：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `client` | — | 复用已有 `Larkflare`；提供后不再创建新客户端 |
| `listScanLimit` | 100000 | `list` 单次最多扫描的行数 |

### `KV`

| 成员 | 说明 |
| --- | --- |
| `client` | 底层 `Larkflare` 实例 |
| `namespace(name)` | 取懒加载命名空间句柄；同步校验名称 |
| `useNamespace(name)` | `namespace` 的别名 |
| `createNamespace(name)` | 创建或接管命名空间并返回句柄 |
| `listNamespaces()` | 列出所有 `kv:<name>` 数据库，返回 `{ name, baseToken }[]` |
| `close()` | 关闭底层客户端；仅在 KV 自己创建客户端时生效 |

### `KVNamespace`

| 成员 | 说明 |
| --- | --- |
| `name` | 命名空间名 |
| `ensure()` | 创建 / 接管 `kv:<name>` Base 与 `entries` 表；单飞、失败可重试 |
| `put(key, value, options?)` | 写入或覆盖一个 key |
| `get(key)` / `get(key, type)` / `get(key, options)` | 读取，默认 `text` |
| `getWithMetadata(...)` | 同上，同时返回 metadata |
| `delete(key)` | 幂等删除 |
| `list(options?)` | 前缀过滤、游标分页、按 key 字典序遍历 |

`put` 接受 `string`、`ArrayBuffer`、`ArrayBufferView`（含 `Buffer` / `Uint8Array`）与 `ReadableStream<Uint8Array>`。`KVPutOptions`：`expiration?`、`expirationTtl?`（互斥，至少 60 秒后）与 `metadata?`（JSON，序列化后不超过 1024 字节）。

`get` 的类型参数决定返回值：`'text'`（默认）、`'json'`、`'arrayBuffer'`、`'stream'`。`cacheTtl` 仅为 Workers KV 兼容而接受，本适配器不做边缘缓存。

`KVListOptions`：`prefix?`、`cursor?`、`limit?`（夹在 1–1000，默认 1000）。`list` 返回 `{ keys, list_complete, cursor? }`；key 按 JavaScript 字符串比较的字典序排列。

## 数据映射

| 概念 | 飞书侧 |
| --- | --- |
| 命名空间 `sessions` | 数据库 Base `larkflare:kv:sessions`（Larkflare 逻辑名 `kv:sessions`） |
| 命名空间内表 | `entries` 一张表 |
| key | 行的 `_id`，一 key 一行 |
| `encoding` | 存储元数据：`utf8` / `base64` / `attachment` |
| `value` | `utf8` 的文本，或 `base64` 的内联二进制；超过 32 KiB 的文本由 DB 转储到云盘 |
| `data` | `attachment` 编码时的 Bitable 附件素材 |
| `metadata` | JSON 列，读取时原样返回 |
| `expiration` | epoch 秒；为空表示不过期 |

写入时四列 `encoding` / `value` / `data` 与 `metadata` / `expiration` 都会显式赋值（缺省为 null），所以覆盖写不会残留旧字节。`encoding` 只描述存储方式，读取端始终先还原成字节再按请求的类型展示，因此字符串写入也能按 `arrayBuffer` 读，二进制写入也能按 `text` 读。

## 约束

| 限制 | 值 |
| --- | --- |
| key 长度 | 非空，不能是 `.` / `..`，UTF-8 不超过 512 字节 |
| value 长度 | 不超过 25 MiB（`ReadableStream` 超限会提前中止） |
| metadata | JSON 可序列化，序列化后不超过 1024 字节 |
| TTL / expiration | 至少 60 秒后 |
| `list` 单页 | 最多 1000 条 |
| `list` 扫描上限 | 默认 100000 行，超出抛 `ListScanLimitExceeded` |
| 文本转储阈值 | 32 KiB |
| 二进制内联阈值 | 16 KiB |

## 与 Cloudflare KV 的差异

- **直读 Bitable**：没有边缘缓存，`cacheTtl` 会被接受但忽略；每次 `get` 都直接读 Bitable（大值再从云盘取回）。
- **过期行只隐藏不删除**：`get` / `getWithMetadata` / `list` 会过滤 `expiration <= now` 的行，但适配器不会主动删除它们；需要回收时请自行清理 `entries`。
- **`list` 扫描整个命名空间**：Bitable 没有 key 前缀索引，`list` 会扫描命名空间后再在客户端过滤、排序与分页；单次超过 `listScanLimit` 会报错。
- **写入只在进程内串行**：新 key 的 find + write 路径按 key 哈希到 64 个互斥条之一，避免同一进程的并发 `put` 产生重复行；跨进程没有服务端唯一约束。
- **最后写入胜出**：并发覆盖同一 key 时没有 CAS 或版本号，最终值是最后完成的写入。
- **没有批量端点**：Workers KV 的批量读写 API 未实现，逐 key 调用即可。

## 飞书应用权限

- `bitable:app`：Bitable 读写、附件（素材）上传下载，以及 DB 的建库建表。
- `space:document:retrieve`：Larkflare 按名称发现并接管已有 Base。

不需要 `drive:drive` 或 `drive:drive:readonly`。Lark 国际版把 `domain` 改成 `https://open.larksuite.com`。

## License

MIT
