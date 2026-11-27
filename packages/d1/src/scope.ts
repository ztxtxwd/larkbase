import { D1Error } from './errors.js'
import { normalizeIdentifier } from './sql.js'
import type { D1Column, D1TableDefinition } from './types.js'

export interface ScopeEntry {
  definition: D1TableDefinition
  /** SQL alias, when the query declares one. */
  alias?: string
}

export interface ScopeSource {
  definition: D1TableDefinition
  /** Name used to qualify columns in SQL. */
  qualifier: string
  /** Prefix applied to row keys so joined sources cannot collide. */
  prefix: string
}

export interface ScopeColumnRef {
  source: ScopeSource
  column: D1Column
  rowKey: string
}

/**
 * Resolves column references for SELECT, including JOINs.
 *
 * A single-source scope keeps the original row keys (the declared column
 * names). Joins prefix each source's keys with its position so same-named
 * columns can coexist; unqualified references to those columns are reported
 * as ambiguous, exactly like SQL.
 */
export class QueryScope {
  readonly sources: ScopeSource[]
  readonly lookup = new Map<string, string>()
  readonly unqualified = new Map<string, ScopeColumnRef | 'ambiguous'>()
  private readonly qualified = new Map<string, ScopeColumnRef>()
  readonly map: Map<string, string>

  constructor(entries: ScopeEntry[], multi = entries.length > 1) {
    const seen = new Set<string>()
    this.sources = entries.map((entry, index) => {
      const qualifier = entry.alias ?? entry.definition.name
      const normalized = normalizeIdentifier(qualifier)
      if (seen.has(normalized)) {
        throw new D1Error(`duplicate table name or alias: ${qualifier}`)
      }
      seen.add(normalized)
      return {
        definition: entry.definition,
        qualifier,
        prefix: multi ? `${index}\u0001` : '',
      }
    })

    for (const source of this.sources) {
      for (const column of source.definition.columns) {
        const rowKey = `${source.prefix}${column.name}`
        const ref: ScopeColumnRef = { source, column, rowKey }
        const qualifiedKey = `${normalizeIdentifier(source.qualifier)}\u0001${normalizeIdentifier(column.name)}`
        this.lookup.set(qualifiedKey, rowKey)
        this.qualified.set(qualifiedKey, ref)
        const nameKey = normalizeIdentifier(column.name)
        this.unqualified.set(nameKey, this.unqualified.has(nameKey) ? 'ambiguous' : ref)
      }
    }

    this.map = new Map<string, string>()
    for (const [key, ref] of this.qualified) this.map.set(key, ref.rowKey)
    for (const [key, ref] of this.unqualified) {
      if (ref !== 'ambiguous') this.map.set(key, ref.rowKey)
    }
  }

  get isEmpty(): boolean {
    return this.sources.length === 0
  }

  /** A scope containing the first `count` sources, for multi-join ON clauses. */
  subScope(count: number): QueryScope {
    return new QueryScope(
      this.sources.slice(0, count).map((source) => ({
        definition: source.definition,
        alias: source.qualifier,
      })),
      this.sources.length > 1,
    )
  }

  resolve(name: string, qualifier?: string): ScopeColumnRef | 'ambiguous' | undefined {
    if (qualifier) {
      return this.qualified.get(
        `${normalizeIdentifier(qualifier)}\u0001${normalizeIdentifier(name)}`,
      )
    }
    return this.unqualified.get(normalizeIdentifier(name))
  }

  rowKey(source: ScopeSource, column: D1Column): string {
    return `${source.prefix}${column.name}`
  }

  /** Columns emitted by `SELECT *`, in source then declaration order. */
  starColumns(): Array<{ label: string; rowKey: string }> {
    const columns: Array<{ label: string; rowKey: string }> = []
    for (const source of this.sources) {
      for (const column of source.definition.columns) {
        columns.push({ label: column.name, rowKey: this.rowKey(source, column) })
      }
    }
    return columns
  }
}
