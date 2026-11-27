export { LarkVectorDB, VECTOR_TABLE_SCHEMA, createRecordId } from './LarkVectorDB.js'
export {
  CONTEXT_TEXT_FIELD,
  DIMENSIONS_FIELD,
  MEDIA_FIELD,
  METADATA_FIELD,
  SOURCE_FIELD,
  UPDATED_AT_FIELD,
  VECTOR_B64_FIELD,
} from './LarkVectorDB.js'
export { hammingDistance, popcount32, quantizeToBinary } from './math.js'
export { VectorSnapshot, assertRecordIdFits } from './snapshot.js'
export type {
  BinaryVector,
  ChunkSource,
  CompositeChunk,
  LarkVectorDBOptions,
  MediaRef,
  MediaTimeRange,
  MediaType,
  RoughMatch,
  VectorMatch,
  VectorRecord,
  VectorSnapshotOptions,
  VectorTable,
  VectorUpsertResult,
} from './types.js'
export { DEFAULT_DIMENSIONS, DEFAULT_ID_BYTES } from './types.js'
