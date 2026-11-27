# Larkbase

**把飞书 / Lark 多维表格变成无头（headless）的 Serverless 数据库，并在其上做零基建的多模态向量检索。**

本仓库是 pnpm monorepo，包含两个可独立安装的包：

| 包 | 作用 | 安装 |
| --- | --- | --- |
| [`@larkbase/core`](./packages/core) | 以飞书多维表格为存储引擎的无服务器 NoSQL 数据库：自动建 Base、建表、建字段、分片、大文件转储、双向关联、公式列 | `pnpm add @larkbase/core` |
| [`@larkbase/vector`](./packages/vector) | 建在 core 之上的零基建多模态向量数据库：复合切片、1-bit 量化、内存汉明距离粗排、Bitable 回表 | `pnpm add @larkbase/vector @larkbase/core` |

## 为什么是"零基建"

- **持久化**：飞书多维表格（结构化行）+ 飞书云盘（大文件与快照附件）。
- **计算**：Node.js / V8 进程内存。没有 Milvus、Qdrant、Redis 或向量网关。
- **扩展**：每个模块只依赖飞书 OpenAPI；快照是可重建的加速器，不是唯一数据源。

## 向量检索架构

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

要求 Node.js >= 18.17。两个包运行时均零第三方依赖。

## License

MIT
