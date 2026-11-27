# Larkflare

**用飞书 / Lark 把 Cloudflare 的 Serverless 数据产品做一遍。**

飞书提供的是「多维表格 + 云盘」这套协作产品；Larkflare 把它们重新包装成 Cloudflare 风格的数据基础设施：按需创建、API 驱动、零外部依赖。底层数据全部落在飞书上，不需要再部署数据库、对象存储或向量引擎。

| 产品 | 包 | 飞书侧存储 | 作用 |
| --- | --- | --- | --- |
| **DB**（基础层） | [`@larkflare/db`](./packages/db) | 多维表格（Bitable） | 无服务器 **NoSQL** 文档引擎：自动建 Base、建表、建字段、分片、大文件转储、双向关联、公式列 |
| **D1** | [`@larkflare/d1`](./packages/d1) | Bitable 表（复用 DB） | 无服务器 **关系型** 数据库：SQL 建表、参数绑定、主键 / 类型约束、`prepare` / `bind` / `batch` |
| **Vectorize** | [`@larkflare/vectorize`](./packages/vectorize) | Bitable 行 + 进程内存 | 零基建多模态向量检索：复合切片、1-bit 量化、内存汉明距离粗排、Bitable 回表 |
| **R2** | [`@larkflare/r2`](./packages/r2) | Bitable 附件 + 飞书云盘 | S3 风格对象存储：桶、对象、前缀列表与 24 小时公开链接 |

DB 是 NoSQL 文档引擎，不是关系型数据库；D1 是独立包，在 DB 之上提供 SQL 语义。Vectorize 与 R2 也复用 DB 的鉴权、建库建表、附件上传与分片能力。

```bash
pnpm add @larkflare/db                        # NoSQL DB
pnpm add @larkflare/d1 @larkflare/db          # D1（关系型）
pnpm add @larkflare/vectorize @larkflare/db   # Vectorize
pnpm add @larkflare/r2 @larkflare/db          # R2
```

> Larkflare 不是 Cloudflare 或飞书官方产品，只是以 Cloudflare 的产品边界为参照，在飞书开放平台 API 之上做的一层实现。

## 为什么是"零基建"

- **持久化**：飞书多维表格（结构化行）+ 飞书云盘（大文件与快照附件）。
- **计算**：Node.js / V8 进程内存。没有 Milvus、Qdrant、Redis 或向量网关。
- **扩展**：每个模块只依赖飞书 OpenAPI；快照是可重建的加速器，不是唯一数据源。

## Vectorize 检索架构

```text
复合切片 CompositeChunk
  ├─ context_text       文本语义锚点
  ├─ media[]            image / audio / video + time_range
  └─ metadata           业务负载
        │
        ├── 完整数据 ──> 飞书多维表格（vector_b64 一并落盘）
        └── 1-bit 素描 ─> VectorSnapshot 扁平 Buffer（16B id + 64B/条）

查询 ──量化──> 内存 XOR + popcount 粗排 ──TopK id──> Bitable batchGet 回表
```

512 维 float32（2 KB）压到 64 字节，压缩 32 倍；100 万条的向量 arena 约 80 MB（另有 id 映射开销），粗排全程只做 32 位整数运算。

## 开发

```bash
pnpm install
pnpm typecheck   # 所有 workspace 包
pnpm test        # 内存版飞书 API，无需真实凭证
pnpm build       # ESM + CJS + d.ts
```

要求 Node.js >= 18.17。所有包运行时均零第三方依赖。

## License

MIT
