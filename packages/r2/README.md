# @larkflare/r2

[![npm](https://img.shields.io/npm/v/%40larkflare%2Fr2.svg)](https://www.npmjs.com/package/@larkflare/r2)
[![CI](https://github.com/ztxtxwd/larkflare/actions/workflows/ci.yml/badge.svg)](https://github.com/ztxtxwd/larkflare/actions/workflows/ci.yml)

**Larkflare R2：飞书云盘上的 S3 风格对象存储。**

这是 Larkflare 对标 Cloudflare R2 的对象存储产品：桶是 Larkflare DB 数据库，对象是 Bitable 中的一行加一个附件素材；没有 S3、MinIO 或任何外部对象存储。

> **从 `@larkbase/r2` 升级？** 包名改为 `@larkflare/r2`；旧桶数据库 Base（`larkbase:r2:<bucket>`）会被 DB 的目录按旧前缀自动收养，无需迁移。

- **S3 语义**：`putObject` / `getObject` / `headObject` / `deleteObject` / `listObjects`，另有 `put` / `get` / `head` / `delete` / `list` 别名。
- **零新依赖**：复用 `@larkflare/db` 的鉴权、重试、限流、建库建表和分片上传。
- **可分享链接**：`getPublicUrl` 返回飞书签发的临时下载链接，24 小时内可直接 `fetch`，不需要 tenant token。
- **存储位置**：对象字节存在飞书云盘，元数据存在 Bitable 行里；覆盖写复用同一行，不会新增重复行。

为什么用 Bitable 附件而不是纯云空间文件夹？飞书官方的 `batch_get_tmp_download_url` 只对云文档媒体签发临时链接，对云空间普通资源文件不生效（"本接口仅支持下载云文档而非云空间中的资源文件"），而 Bitable 附件素材正好属于前者，所以不必自建下载代理就能实现 `getPublicUrl`。

```bash
pnpm add @larkflare/r2 @larkflare/db
```

## 快速开始

```ts
import { createR2 } from '@larkflare/r2'

const r2 = createR2({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
})

// 桶在第一次操作时按需创建
const bucket = await r2.createBucket('photos')

// 写入（Buffer / Uint8Array / ArrayBuffer / string / Blob / AsyncIterable）
await bucket.putObject('2026/cat.png', pngBytes, {
  metadata: { owner: 'ada', scene: 'cover' },
})

const object = await bucket.getObject('2026/cat.png')
console.log(object.body, object.size, object.etag, object.contentType)

const head = await bucket.headObject('2026/cat.png') // 不下载正文
const publicUrl = await bucket.getPublicUrl('2026/cat.png')

const page = await bucket.listObjects({ prefix: '2026/', delimiter: '/' })
console.log(page.objects, page.commonPrefixes, page.isTruncated)

await bucket.deleteObject('2026/cat.png')
```

已有 `@larkflare/db` 客户端时可以直接复用，不重复建连接：

```ts
import { createClient } from '@larkflare/db'
import { createR2 } from '@larkflare/r2'

const client = createClient({ appId, appSecret })
const r2 = createR2({ client, listScanLimit: 200_000 })
```

## API

`createR2(options): R2`

`R2Options` 继承 `LarkflareConfig`，并额外接受：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `client` | — | 复用已有 `Larkflare`；提供后不再创建新客户端 |
| `publicUrlTtlMs` | 24 小时 | 临时链接缓存时长 |
| `publicUrlRefreshMarginMs` | 5 分钟 | 提前刷新窗口 |
| `publicUrlBatchSize` | 5 | 每次请求的 token 数，自动夹在 1–5 |
| `listScanLimit` | 100000 | `listObjects` 单次最多扫描的行数 |

`R2`

| 方法 | 说明 |
| --- | --- |
| `client` | 底层 `Larkflare` 实例 |
| `bucket(name)` | 取懒加载桶句柄；同步校验桶名 |
| `createBucket(name)` | 创建或接管桶并返回句柄 |
| `listBuckets()` | 列出所有 `r2:<name>` 数据库，返回 `{ name, baseToken }[]` |

`R2Bucket`

| 方法 | 说明 |
| --- | --- |
| `ensure()` | 创建 / 接管桶的 Base 与 `objects` 表；单飞、失败可重试 |
| `putObject(key, body, options?)` | 上传并 upsert 一行；返回 `R2HeadObjectResult` |
| `getObject(key)` | 下载正文，返回 `R2Object`（含 `body: Buffer`） |
| `headObject(key)` | 只读元数据，不下载正文 |
| `deleteObject(key)` | 幂等删除；行不存在返回 `false` |
| `listObjects(options?)` | 前缀 / 分隔符 / 游标 / `startAfter` 列表 |
| `getPublicUrl(key)` | 单个对象的临时下载链接 |
| `getPublicUrls(keys)` | 批量取链接，内部按 5 个 token 合并请求 |
| `put` / `get` / `head` / `delete` / `list` | 上述方法的别名 |

`PutObjectOptions`：`contentType?`、`metadata?`（字符串键值对）、`fileName?`。

`ListObjectsOptions`：`prefix?`、`delimiter?`、`cursor?`、`startAfter?`、`limit?`（夹在 1–1000，默认 1000）。

## 数据映射

| 概念 | 飞书侧 |
| --- | --- |
| 桶 `photos` | 数据库 Base `larkflare:r2:photos`（Larkflare 逻辑名 `r2:photos`） |
| 桶内表 | `objects` 一张表 |
| 对象 key | 行的 `_id`，一 key 一行 |
| 对象正文 | Bitable 附件素材（`bitable_file`，`image/*` 用 `bitable_image`） |
| 行字段 | `data` 附件、`size` 数字、`etag` 文本、`content_type` 文本、`metadata` JSON、`updated_at` 日期 |

`etag` 是正文字节的 SHA-256（小写十六进制）。写对象时按 key 先 `get` 再 `update`，因此重复写同一个 key 只保留一行；对象 key 是不透明字符串，不参与路径拆分，也不用于文件名查找。

## 公开链接池

`getPublicUrl` / `getPublicUrls` 背后是一个进程内缓存：

- 链接有效期 24 小时，缓存提前 5 分钟过期（都可配置）。
- 同一 token 的并发请求合并为一个 Promise。
- 同一 tick 内排队的 token 由一次微任务统一 flush，每 5 个 token 发一次飞书请求。
- `getPublicUrls` 先 `batchGet` 一次性读出所有行，再在同一 tick 里把 token 一起交给池，所以 7 个对象只会产生 5 + 2 两次请求。
- 删除对象会让对应 token 的缓存失效。

链接本身是 bearer 凭证：拿到链接即可下载，无需 token，因此不要写进日志、截图或公开仓库。

## 约束与调优

- **空文件**：飞书素材上传拒绝 0 字节文件，`putObject` 会在上传前抛 `ValidationError`。
- **覆盖写会留下旧素材**：飞书没有删除素材的 API。覆盖同一个 key 会更新行并上传新素材，旧素材继续占用云盘空间。
- **列表是 O(桶大小)**：Bitable 没有前缀索引，`listObjects` 会扫描整桶再在客户端排序、分组。超过 `listScanLimit` 时会抛错并提示调大该值。
- **桶名规则**：3–63 个字符，仅小写字母、数字、点和连字符，首尾必须是字母或数字，不能含 `..`，不能是 IPv4 形状。
- **key 规则**：非空、UTF-8 不超过 1024 字节、不能含 C0 控制字符或 DEL；其余字符（包括前导 `/`）原样保留。
- **多进程并发写同一 key** 可能留下重复行：Larkflare 没有服务端唯一约束，行级 upsert 只在单进程内尽力去重。
- **正文会整体进内存**：`putObject` 会把 body 归一成一个 Buffer，`getObject` 也会完整下载后才返回；超大对象的流式传输属于后续阶段。
- **临时链接**只适用于 Bitable 附件一类的云文档媒体，不适用于云空间里的普通资源文件。
- **高级权限 Base**：飞书要求下载素材和换取临时链接时额外传 `extra` 鉴权参数，本包当前未传递。请保持桶 Base 的高级权限关闭；如果必须开启，请直接使用附件元数据里的 `url` / `tmp_url` 自行访问。

## 飞书应用权限

- `bitable:app`：覆盖 Bitable 读写、附件（素材）上传 / 下载，以及 `batch_get_tmp_download_url`。
- `space:document:retrieve`：Larkflare 仍需要它按名称发现并接管已有的 Base。

不需要 `drive:drive` 或 `drive:drive:readonly`。Lark 国际版把 `domain` 改成 `https://open.larksuite.com`。

## License

MIT
