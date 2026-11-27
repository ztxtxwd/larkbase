# @larkflare/vectorize

[![npm](https://img.shields.io/npm/v/%40larkflare%2Fvectorize.svg)](https://www.npmjs.com/package/@larkflare/vectorize)
[![CI](https://github.com/ztxtxwd/larkflare/actions/workflows/ci.yml/badge.svg)](https://github.com/ztxtxwd/larkflare/actions/workflows/ci.yml)

**Larkflare Vectorize：建在 DB 之上的零基建多模态向量索引。**

这是 Larkflare 对标 Cloudflare Vectorize 的向量检索产品：持久化用飞书多维表格 + 云盘，检索计算在 Node.js 内存中完成；不依赖 Milvus / Qdrant / Redis 等任何外部服务。

> **从 `@larkbase/vector` 升级？** 包名改为 `@larkflare/vectorize`；`LarkVectorDB` / `LarkVectorDBOptions` 改名为 `VectorizeIndex` / `VectorizeIndexOptions`。快照文件 magic 从 `LKVS` 改为 `LFVS`，旧快照仍可读取；Bitable 行本身无需迁移。

- **复合切片**：一条记录 = `context_text`（文本语义锚点）+ `media[]`（图片 / 音频 / 视频 + 时间范围）+ `source` + `metadata`。
- **1-bit 量化**：512 维归一化 embedding 压成 64 字节；100 万条的向量 arena 约 80 MB（另有 id 映射开销）。
- **两段式检索**：内存中对二值素描做 XOR + popcount 粗排，拿到 Top K `_id` 后调用 `@larkflare/db` 的 `batchGet` 回表。
- **可持久化索引**：`exportSnapshot()` 输出单文件 Buffer，可上传云盘 / 作为附件保存；冷启动 `loadSnapshot()` 即恢复。

```bash
pnpm add @larkflare/vectorize @larkflare/db
```

## 快速开始

```ts
import { createClient } from '@larkflare/db'
import { VectorizeIndex, VECTOR_TABLE_SCHEMA, createRecordId } from '@larkflare/vectorize'

const client = createClient({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
})

// 1. 建表：VECTOR_TABLE_SCHEMA 声明了 context_text / source / media /
//    metadata / vector_b64 / dimensions / updated_at 七列。
const chunks = client
  .useDatabase('knowledge')
  .defineTable('chunks', VECTOR_TABLE_SCHEMA)

// 2. 初始化（默认 512 维、16 字节 id 槽）
const vector = new VectorizeIndex(chunks)

// 3. 写入复合切片 + float embedding
await vector.upsert(
  {
    id: createRecordId(), // 16 字符 Crockford Base32，正好填满 16 字节槽
    source: { doc_token: 'doxcn...', block_id: 'blk...' },
    media: [
      { file_token: 'boxcn...', type: 'image', caption: '写入路径架构图' },
      { file_token: 'boxcn...', type: 'audio', time_range: { start_ms: 12_000, end_ms: 28_500 } },
    ],
    context_text: '写入路径先落 Bitable，再更新本地二值索引；回表按 _id 批量读取。',
    metadata: { lang: 'zh', author: 'expert', confidence: 0.92 },
  },
  embedding, // number[] | Float32Array，长度必须为 512
)

// 4. 两段式检索
const hits = await vector.search(queryEmbedding, 5)
for (const hit of hits) {
  console.log(hit.recordId, hit.distance, hit.chunk.context_text, hit.chunk.media)
  // hit.document 是 Bitable 原始行（含 vector_b64 / updated_at）
}

// 5. 持久化索引（上传飞书云盘或存为附件）
const snapshot = vector.exportSnapshot()

// 新进程冷启动
const restored = new VectorizeIndex(chunks)
restored.loadSnapshot(snapshot)
```

## 数据模型

| 类型 | 说明 |
| --- | --- |
| `ChunkSource` | `doc_token`、`block_id`、`url`、任意 `metadata` |
| `MediaRef` | `file_token`、`type: 'image' \| 'audio' \| 'video'`、`time_range?`、`caption?` 等 |
| `CompositeChunk` | `id`、`source`、`media[]`、`context_text`、`metadata` |
| `VectorRecord` | Bitable 物理行：上述字段 + `vector_b64` + `dimensions` + `updated_at` |
| `VectorMatch` | 检索结果：`recordId`、`distance`、重建后的 `chunk`、原始 `document` |

## 两段式检索

```text
query float[512]
   │ quantizeToBinary (>0 → 1, <=0 → 0)
   ▼
64-byte sketch
   │ 遍历内存 arena：16 次 Uint32 XOR + SWAR popcount / 条
   ▼
Top K (recordId, distance)          ← 粗排：仅内存，无 API 调用
   │ table.batchGet(ids)
   ▼
完整 CompositeChunk + media 引用     ← 回表：每分片一次批量查询
```

粗排距离是**二值素描上的精确汉明距离**，相对原始 float embedding 是近似召回；`distance` 范围 `[0, 512]`，越小越接近。需要更精细的排序时，可在回表后对 Top K 用原始向量做二次精排（后续阶段）。

## 量化与内存布局

- 量化：维度 `i` 写入字节 `i >> 3` 的位 `i & 7`（LSB first）；`> 0` 为 1，其余为 0。512 维 = 64 字节。
- 快照 arena：`[record id: idBytes][packed vector: vectorBytes]` 连续交错，默认每条 **80 字节**。
- 扫描：当 `idBytes` 是 4 的倍数（默认 16）时，整块 arena 直接建 `Uint32Array` 视图，每条向量只需 16 次 `xor` + popcount，无需创建子数组、无需字符串转换。
- Top-K：固定大小最小堆，预分配两个 `Uint32Array`；扫描阶段零对象分配，只在最后为胜出的 K 条解码 id。
- 并发安全：`search` 与 `add` 是同步内存操作；`upsert` 先写 Bitable，成功后才更新内存索引。

## 快照文件格式

`VectorSnapshot.toBuffer()` 输出自描述的单文件：

| 偏移 | 内容 |
| --- | --- |
| 0 | magic `LFVS`（旧版 `LKVS` 仍可读取） |
| 4 | version (u16 LE) |
| 6 | header size (u16 LE) |
| 8 | idBytes (u16 LE) |
| 10 | vectorBytes (u16 LE) |
| 12 | dimensions (u32 LE) |
| 16 | entry count (u32 LE) |
| 20 | FNV-1a checksum (u32 LE) |
| 32 | 交错 arena |

`fromBuffer()` 会校验 magic、版本、槽宽、长度和校验和，并拒绝重复 / 非法 id。文件可直接上传飞书云盘，也可以作为 Bitable 附件保存。

## 基准测试

```bash
pnpm --filter @larkflare/vectorize bench            # 20 万条
pnpm --filter @larkflare/vectorize bench -- 1000000 # 100 万条
```

脚本测量入栏（含量化）、Top-K 粗排的每秒查询数与每条向量的纳秒开销；使用确定性 PRNG，便于对比不同机器和提交。参考量级：现代 x86 服务器上，20 万条 512 维、Top-10 粗排约 15 ms/次（即约 75 ns/条）。

## API

`VectorizeIndex`

| 方法 / 属性 | 说明 |
| --- | --- |
| `constructor(table, options?)` | 接收 `@larkflare/db` 的 `Table`（或实现 `VectorTable` 的对象）；可选 `dimensions`、`idBytes`、`initialCapacity`、`snapshot` |
| `upsert(chunk, floatVector)` | 写 / 更新 Bitable 行，然后更新内存索引；返回 `{ recordId, created, dimensions, vectorBytes }` |
| `search(floatVector, topK = 5)` | 粗排 + `batchGet` 回表，返回 `VectorMatch[]` |
| `exportSnapshot()` | 序列化当前索引为 `Buffer` |
| `loadSnapshot(buffer)` | 加载快照（维度与 id 宽度必须匹配），返回 `this` |
| `size` / `dimensions` / `vectorBytes` / `idBytes` | 当前索引信息 |

`VectorSnapshot`

| 方法 / 属性 | 说明 |
| --- | --- |
| `add(id, packedVector)` | 插入；同 id 覆盖旧向量 |
| `searchRough(query, topK)` | 返回 `string[]`，按距离升序 |
| `searchRoughDetailed(query, topK)` | 返回 `{ recordId, distance }[]` |
| `getVector(id)` / `idAt(index)` / `has(id)` | 读取辅助 |
| `toBuffer()` / `VectorSnapshot.fromBuffer(buffer)` | 序列化 / 反序列化 |
| `size` / `capacity` / `dimensions` / `byteLength` | 统计信息 |

数学工具：`quantizeToBinary`、`hammingDistance`、`popcount32`。

## 约束与调优

- **维度**：默认 512；必须是 32 的倍数（每条约素描需 4 字节对齐）。
- **id**：UTF-8 编码必须 ≤ `idBytes`（默认 16 字节），且不能含 NUL。用 `createRecordId()` 生成 16 字符 id；CJK 等非 ASCII id 会更早触顶。
- **embedding**：按约定做归一化；量化只保留符号，范数信息会丢失。
- **快照与写入**：阶段一不会自动上传快照。批量写入后请重新 `exportSnapshot()`；丢失快照不会丢数据，`vector_b64` 仍在 Bitable 中（全量重建索引属于下一阶段）。
- **删除**：阶段一未暴露 `delete`；被删行在回表时会自动跳过（`search` 优雅降级），但残留 id 仍占用粗排名额，建议重建快照。
- **规模**：线性扫描适合十万到百万级切片；更大规模可在此基础上叠加 IVF / 多表分片。

## License

MIT
