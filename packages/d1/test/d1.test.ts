import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createD1, D1Error, type D1 } from '../src/index.js'
import { FakeFeishu } from '../../db/test/fake-feishu.js'

interface Harness {
  fake: FakeFeishu
  d1: D1
  db: ReturnType<D1['database']>
  stop: () => Promise<void>
}

async function harness(name = 'sql_app'): Promise<Harness> {
  const fake = await new FakeFeishu().start()
  const d1 = createD1({
    appId: 'test-app',
    appSecret: 'test-secret',
    domain: fake.url,
    batchWindowMs: 5,
    catalogFlushMs: 0,
    bitableQps: 100,
    driveQps: 100,
  })
  return {
    fake,
    d1,
    db: d1.database(name),
    stop: async () => {
      await d1.close().catch(() => {})
      await fake.stop()
    },
  }
}

test('CREATE TABLE, INSERT and SELECT preserve relational types', async () => {
  const { db, stop } = await harness()
  try {
    await db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        age INTEGER,
        active BOOLEAN DEFAULT TRUE,
        profile JSON,
        avatar BLOB
      )
    `)

    const insert = await db
      .prepare('INSERT INTO users (name, age, profile) VALUES (?, ?, ?)')
      .bind('Ada', 36, { lang: 'en', tags: ['math'] })
      .run()
    assert.equal(insert.success, true)
    assert.equal(insert.meta.changes, 1)
    assert.equal(insert.meta.last_row_id, 1)
    assert.equal(insert.meta.rows_written, 1)

    const second = await db
      .prepare('INSERT INTO users (name, age) VALUES (?, ?)')
      .bind('Grace', 85)
      .run()
    assert.equal(second.meta.last_row_id, 2)

    const all = await db.prepare('SELECT * FROM users ORDER BY id').all()
    assert.deepEqual(all.results, [
      {
        id: 1,
        name: 'Ada',
        age: 36,
        active: true,
        profile: { lang: 'en', tags: ['math'] },
        avatar: null,
      },
      {
        id: 2,
        name: 'Grace',
        age: 85,
        active: true,
        profile: null,
        avatar: null,
      },
    ])
    assert.equal(all.meta.rows_read, 2)
  } finally {
    await stop()
  }
})

test('WHERE, ORDER BY, LIMIT, OFFSET and projection expressions', async () => {
  const { db, stop } = await harness('sql_queries')
  try {
    await db.exec(`
      CREATE TABLE people (
        id INTEGER PRIMARY KEY,
        name TEXT,
        age INTEGER,
        city TEXT
      );
      INSERT INTO people (name, age, city) VALUES
        ('Ada', 36, 'London'),
        ('Grace', 85, 'Arlington'),
        ('Alan', 41, 'London'),
        ('Edsger', 72, 'Austin');
    `)

    const adults = await db
      .prepare('SELECT name, age * 2 AS double_age FROM people WHERE age >= ? ORDER BY age DESC LIMIT ?')
      .bind(40, 3)
      .all()
    assert.deepEqual(adults.results, [
      { name: 'Grace', double_age: 170 },
      { name: 'Edsger', double_age: 144 },
      { name: 'Alan', double_age: 82 },
    ])

    const page = await db
      .prepare('SELECT name FROM people ORDER BY age LIMIT ? OFFSET ?')
      .bind(2, 1)
      .all()
    assert.deepEqual(page.results, [{ name: 'Alan' }, { name: 'Edsger' }])

    const londoners = await db
      .prepare("SELECT name FROM people WHERE city = ? AND name LIKE ? ORDER BY name")
      .bind('London', '%a%')
      .all()
    assert.deepEqual(londoners.results, [{ name: 'Ada' }, { name: 'Alan' }])

    const inList = await db
      .prepare('SELECT name FROM people WHERE age IN (?, ?) ORDER BY age')
      .bind(36, 85)
      .all()
    assert.deepEqual(inList.results, [{ name: 'Ada' }, { name: 'Grace' }])

    const nulls = await db.prepare('SELECT COUNT(*) AS n FROM people WHERE city IS NULL').all()
    assert.deepEqual(nulls.results, [{ n: 0 }])

    const byAlias = await db
      .prepare('SELECT name, age * 2 AS double_age FROM people ORDER BY double_age DESC LIMIT 1')
      .all()
    assert.deepEqual(byAlias.results, [{ name: 'Grace', double_age: 170 }])
  } finally {
    await stop()
  }
})

test('UPDATE and DELETE report changes and respect WHERE', async () => {
  const { db, stop } = await harness('sql_mutations')
  try {
    await db.exec(`
      CREATE TABLE counters (id INTEGER PRIMARY KEY, name TEXT NOT NULL, value INTEGER NOT NULL);
      INSERT INTO counters (name, value) VALUES ('a', 1), ('b', 2), ('c', 3);
    `)

    const updated = await db
      .prepare('UPDATE counters SET value = value + 10, name = ? WHERE id = ?')
      .bind('A', 1)
      .run()
    assert.equal(updated.meta.changes, 1)
    assert.deepEqual((await db.prepare('SELECT * FROM counters WHERE id = 1').first()), {
      id: 1,
      name: 'A',
      value: 11,
    })

    const deleteResult = await db.prepare('DELETE FROM counters WHERE value > ?').bind(5).run()
    assert.equal(deleteResult.meta.changes, 1)
    assert.deepEqual((await db.prepare('SELECT name FROM counters ORDER BY id').all()).results, [
      { name: 'b' },
      { name: 'c' },
    ])

    const noop = await db.prepare('DELETE FROM counters WHERE id = ?').bind(999).run()
    assert.equal(noop.meta.changes, 0)

    await db.exec('DROP TABLE counters')
    await assert.rejects(db.prepare('SELECT * FROM counters').all(), /no such table/)
    await db.exec('DROP TABLE IF EXISTS counters')
    assert.deepEqual(await db.listTables(), [])
  } finally {
    await stop()
  }
})

test('constraints, defaults and type checks are enforced', async () => {
  const { db, stop } = await harness('sql_constraints')
  try {
    await db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        age INTEGER DEFAULT 18,
        active BOOLEAN DEFAULT FALSE
      )
    `)

    await db.prepare('INSERT INTO accounts (email) VALUES (?)').bind('a@example.com').run()
    const row = await db.prepare('SELECT * FROM accounts').first()
    assert.deepEqual(row, { id: 1, email: 'a@example.com', age: 18, active: false })

    await assert.rejects(
      db.prepare('INSERT INTO accounts (email) VALUES (?)').bind('a@example.com').run(),
      /UNIQUE constraint failed/,
    )
    await assert.rejects(
      db.prepare('INSERT INTO accounts (email) VALUES (?)').bind(null).run(),
      /NOT NULL constraint failed/,
    )
    await assert.rejects(
      db.prepare('INSERT INTO accounts (email, age) VALUES (?, ?)').bind('b@example.com', 1.5).run(),
      /expects an INTEGER/,
    )
    await assert.rejects(
      db.prepare('INSERT INTO accounts (email, active) VALUES (?, ?)').bind('c@example.com', 'yes').run(),
      /expects a BOOLEAN/,
    )

    await db.prepare('INSERT INTO accounts (email, age) VALUES (?, ?)').bind('d@example.com', 40).run()
    await assert.rejects(
      db.prepare('UPDATE accounts SET email = ? WHERE email = ?').bind('a@example.com', 'd@example.com').run(),
      /UNIQUE constraint failed/,
    )

    await assert.rejects(db.exec('CREATE TABLE accounts (id INTEGER)'), /already exists/)
    await db.exec('CREATE TABLE IF NOT EXISTS accounts (id INTEGER)')
    await assert.rejects(
      db.exec('CREATE TABLE bad (id INTEGER PRIMARY KEY, other INTEGER, PRIMARY KEY (other))'),
      /table-level constraints/,
    )
    await assert.rejects(
      db.exec('CREATE TABLE bad (id BLOB UNIQUE)'),
      /UNIQUE \/ PRIMARY KEY is not supported/,
    )
    await assert.rejects(db.exec('ALTER TABLE accounts ADD COLUMN x TEXT'), /not supported/)
  } finally {
    await stop()
  }
})

test('aggregate functions, GROUP BY, HAVING and aggregate ordering', async () => {
  const { db, stop } = await harness('sql_aggregates')
  try {
    await db.exec(`
      CREATE TABLE sales (id INTEGER PRIMARY KEY, amount INTEGER, region TEXT);
      INSERT INTO sales (amount, region) VALUES (10, 'eu'), (20, 'us'), (31, 'eu');
    `)

    const totals = await db
      .prepare(`
        SELECT COUNT(*) AS n, SUM(amount) AS total, AVG(amount) AS average,
               MIN(amount) AS smallest, MAX(amount) AS largest
        FROM sales
      `)
      .all()
    assert.deepEqual(totals.results, [
      { n: 3, total: 61, average: 61 / 3, smallest: 10, largest: 31 },
    ])

    const eu = await db
      .prepare('SELECT COUNT(*) + 1 AS n FROM sales WHERE region = ?')
      .bind('eu')
      .all()
    assert.deepEqual(eu.results, [{ n: 3 }])

    const byRegion = await db
      .prepare(`
        SELECT region, COUNT(*) AS n, SUM(amount) AS total
        FROM sales
        GROUP BY region
        ORDER BY region
      `)
      .all()
    assert.deepEqual(byRegion.results, [
      { region: 'eu', n: 2, total: 41 },
      { region: 'us', n: 1, total: 20 },
    ])

    const having = await db
      .prepare(`
        SELECT region, COUNT(*) AS n
        FROM sales
        GROUP BY region
        HAVING COUNT(*) > 1
        ORDER BY n DESC
      `)
      .all()
    assert.deepEqual(having.results, [{ region: 'eu', n: 2 }])

    const aliasHaving = await db
      .prepare(`
        SELECT region AS r, COUNT(*) AS n
        FROM sales
        GROUP BY r
        HAVING n > 1
        ORDER BY n DESC
      `)
      .all()
    assert.deepEqual(aliasHaving.results, [{ r: 'eu', n: 2 }])

    const groupedExpression = await db
      .prepare(`
        SELECT amount + 1 AS adjusted, COUNT(*) AS n
        FROM sales
        GROUP BY amount + 1
        ORDER BY adjusted
      `)
      .all()
    assert.deepEqual(groupedExpression.results, [
      { adjusted: 11, n: 1 },
      { adjusted: 21, n: 1 },
      { adjusted: 32, n: 1 },
    ])

    const derived = await db
      .prepare(`
        SELECT region, SUM(amount) / COUNT(*) AS average
        FROM sales
        GROUP BY region
        ORDER BY average DESC
      `)
      .all()
    assert.deepEqual(derived.results, [
      { region: 'eu', average: 20.5 },
      { region: 'us', average: 20 },
    ])

    const noRows = await db
      .prepare('SELECT COUNT(*) AS n FROM sales WHERE region = ?')
      .bind('nope')
      .all()
    assert.deepEqual(noRows.results, [{ n: 0 }])

    await assert.rejects(
      db.prepare('SELECT amount, COUNT(*) FROM sales').all(),
      /must appear in GROUP BY or an aggregate function/,
    )
    await assert.rejects(
      db.prepare('SELECT COUNT(*) FROM sales ORDER BY amount').all(),
      /must appear in GROUP BY or an aggregate function/,
    )
    await assert.rejects(
      db.prepare('SELECT region FROM sales GROUP BY amount').all(),
      /must appear in GROUP BY or an aggregate function/,
    )
  } finally {
    await stop()
  }
})

test('INNER JOIN, LEFT JOIN and qualified columns', async () => {
  const { db, stop } = await harness('sql_joins')
  try {
    await db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL);
      INSERT INTO users (id, name) VALUES (1, 'Ada'), (2, 'Grace'), (3, 'Alan');
      INSERT INTO orders (user_id, amount) VALUES (1, 10), (1, 20), (2, 30);
    `)

    const inner = await db
      .prepare(`
        SELECT u.name, o.amount
        FROM users AS u
        INNER JOIN orders AS o ON u.id = o.user_id
        ORDER BY u.name, o.amount
      `)
      .all()
    assert.deepEqual(inner.results, [
      { name: 'Ada', amount: 10 },
      { name: 'Ada', amount: 20 },
      { name: 'Grace', amount: 30 },
    ])

    const left = await db
      .prepare(`
        SELECT u.name, COUNT(o.id) AS orders, SUM(o.amount) AS total
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        GROUP BY u.name
        ORDER BY u.name
      `)
      .all()
    assert.deepEqual(left.results, [
      { name: 'Ada', orders: 2, total: 30 },
      { name: 'Alan', orders: 0, total: null },
      { name: 'Grace', orders: 1, total: 30 },
    ])

    const unmatched = await db
      .prepare(`
        SELECT u.name
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        WHERE o.id IS NULL
      `)
      .all()
    assert.deepEqual(unmatched.results, [{ name: 'Alan' }])

    const raw = await db
      .prepare(`
        SELECT *
        FROM users u
        JOIN orders o ON u.id = o.user_id
        ORDER BY o.id
        LIMIT 1
      `)
      .raw({ columnNames: true })
    assert.deepEqual(raw, [
      ['id', 'name', 'id', 'user_id', 'amount'],
      [1, 'Ada', 1, 1, 10],
    ])

    const crossed = await db
      .prepare('SELECT COUNT(*) AS n FROM users CROSS JOIN orders')
      .all()
    assert.deepEqual(crossed.results, [{ n: 9 }])

    const selfJoin = await db
      .prepare(`
        SELECT a.name, b.name AS other
        FROM users a
        JOIN users b ON a.id = b.id
        WHERE a.id = ?
      `)
      .bind(1)
      .all()
    assert.deepEqual(selfJoin.results, [{ name: 'Ada', other: 'Ada' }])

    await assert.rejects(
      db.prepare('SELECT id FROM users u JOIN orders o ON u.id = o.user_id').all(),
      /ambiguous column name/,
    )
    await assert.rejects(
      db.prepare('SELECT x.name FROM users u JOIN orders o ON u.id = o.user_id').all(),
      /no such column/,
    )
    await assert.rejects(
      db.exec('SELECT * FROM users u RIGHT JOIN orders o ON u.id = o.user_id'),
      /RIGHT JOIN is not supported/,
    )
    await assert.rejects(
      db.exec('SELECT * FROM users u JOIN orders o USING (id)'),
      /USING is not supported/,
    )
  } finally {
    await stop()
  }
})

test('foreign keys use RESTRICT semantics', async () => {
  const { db, stop } = await harness('sql_foreign_keys')
  try {
    await db.exec(`
      CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        author_id INTEGER NOT NULL REFERENCES authors(id),
        title TEXT
      );
      INSERT INTO authors (id, name) VALUES (1, 'Ada'), (2, 'Grace');
      INSERT INTO books (author_id, title) VALUES (1, 'Notes');
    `)

    await assert.rejects(
      db.prepare('INSERT INTO books (author_id, title) VALUES (?, ?)').bind(99, 'Orphan').run(),
      /FOREIGN KEY constraint failed/,
    )
    await assert.rejects(
      db.prepare('DELETE FROM authors WHERE id = ?').bind(1).run(),
      /still references/,
    )
    await assert.rejects(
      db.prepare('UPDATE authors SET id = ? WHERE id = ?').bind(10, 1).run(),
      /still references/,
    )

    await db.prepare('UPDATE books SET author_id = ? WHERE author_id = ?').bind(2, 1).run()
    await db.prepare('DELETE FROM authors WHERE id = ?').bind(1).run()

    await assert.rejects(db.exec('DROP TABLE authors'), /referenced by/)
    await db.exec('DROP TABLE books; DROP TABLE authors')

    await assert.rejects(
      db.exec('CREATE TABLE bad (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES missing(id))'),
      /no such table/,
    )

    await db.exec('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)')
    await assert.rejects(
      db.exec('CREATE TABLE bad (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(nope))'),
      /no such column/,
    )
    await assert.rejects(
      db.exec('CREATE TABLE bad (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(name))'),
      /must be PRIMARY KEY or UNIQUE/,
    )
    await db.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT)')
    await assert.rejects(
      db.exec('CREATE TABLE bad (id INTEGER PRIMARY KEY, tag_id INTEGER REFERENCES tags(name))'),
      /must be PRIMARY KEY or UNIQUE/,
    )
    await db.exec('CREATE TABLE tagged (id INTEGER PRIMARY KEY, tag_id INTEGER REFERENCES tags)')
    await assert.rejects(
      db.exec('CREATE TABLE bad (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tags(id) ON DELETE CASCADE)'),
      /ON DELETE \/ ON UPDATE actions are not supported/,
    )

    await db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').bind(1, 'sql').run()
    await db.prepare('INSERT INTO tagged (tag_id) VALUES (?)').bind(1).run()
    await assert.rejects(
      db.prepare('DELETE FROM tags WHERE id = ?').bind(1).run(),
      /still references/,
    )

    await db.exec(`
      CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES nodes(id));
      INSERT INTO nodes (id, parent_id) VALUES (1, NULL), (2, 1), (3, 1);
    `)
    await assert.rejects(
      db.prepare('DELETE FROM nodes WHERE id IN (?, ?)').bind(1, 2).run(),
      /still references/,
    )
    await db.prepare('DELETE FROM nodes WHERE id = ?').bind(3).run()
    const deleted = await db.prepare('DELETE FROM nodes WHERE id IN (?, ?)').bind(1, 2).run()
    assert.equal(deleted.meta.changes, 2)
  } finally {
    await stop()
  }
})

test('batch, exec, first, raw and dump', async () => {
  const { db, stop } = await harness('sql_misc')
  try {
    const execResult = await db.exec(`
      CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body BLOB);
      INSERT INTO notes (title) VALUES ('one');
    `)
    assert.equal(execResult.count, 2)
    assert.ok(execResult.duration >= 0)
    await db
      .prepare('UPDATE notes SET body = ? WHERE id = 1')
      .bind(Buffer.from('hi'))
      .run()

    const results = await db.batch([
      db.prepare('INSERT INTO notes (title) VALUES (?)').bind('two'),
      db.prepare('SELECT title FROM notes ORDER BY id'),
    ])
    assert.equal(results.length, 2)
    assert.equal(results[0]!.meta.changes, 1)
    assert.deepEqual(results[1]!.results, [{ title: 'one' }, { title: 'two' }])

    assert.equal(await db.prepare('SELECT title FROM notes WHERE id = 1').first<string>('title'), 'one')
    assert.equal(await db.prepare('SELECT title FROM notes WHERE id = 999').first(), null)

    const raw = await db
      .prepare('SELECT id, title FROM notes ORDER BY id LIMIT 1')
      .raw({ columnNames: true })
    assert.deepEqual(raw, [
      ['id', 'title'],
      [1, 'one'],
    ])

    const blob = await db.prepare('SELECT body FROM notes WHERE id = 1').first<ArrayBuffer>('body')
    assert.ok(blob instanceof ArrayBuffer)
    assert.equal(Buffer.from(blob).toString('utf8'), 'hi')

    const dump = Buffer.from(await db.dump()).toString('utf8')
    assert.match(dump, /CREATE TABLE "notes"/)
    assert.match(dump, /INSERT INTO "notes"/)
    assert.match(dump, /X'6869'/)

    const tables = await db.listTables()
    assert.equal(tables.length, 1)
    assert.equal(tables[0]!.name, 'notes')
    assert.equal(tables[0]!.rowCount, 2)
    assert.deepEqual(
      tables[0]!.columns.map((column) => column.name),
      ['id', 'title', 'body'],
    )
  } finally {
    await stop()
  }
})

test('a D1 database survives a client restart', async () => {
  const fake = await new FakeFeishu().start()
  const options = {
    appId: 'test-app',
    appSecret: 'test-secret',
    domain: fake.url,
    batchWindowMs: 5,
    catalogFlushMs: 0,
  }
  try {
    const first = createD1(options)
    const db = first.database('sql_persist')
    await db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      INSERT INTO items (name) VALUES ('kept');
    `)
    await first.close()

    const second = createD1(options)
    try {
      const reopened = second.database('sql_persist')
      const table = await reopened.prepare('SELECT * FROM items').first()
      assert.deepEqual(table, { id: 1, name: 'kept' })

      const insert = await reopened
        .prepare('INSERT INTO items (name) VALUES (?)')
        .bind('new')
        .run()
      assert.equal(insert.meta.last_row_id, 2)

      const bases = [...fake.bases.values()].map((base) => base.name)
      assert.ok(bases.includes('larkflare:sql_persist'))
      assert.ok(bases.includes('__larkflare_catalog__'))
    } finally {
      await second.close()
    }
  } finally {
    await fake.stop()
  }
})

test('unsupported SQL and malformed input fail loudly', async () => {
  const { db, stop } = await harness('sql_errors')
  try {
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    await assert.rejects(db.exec('SELECT * FROM missing'), /no such table/)
    await assert.rejects(
      db.exec('SELECT * FROM t JOIN t AS other'),
      /JOIN requires an ON condition/,
    )
    await assert.rejects(db.exec('BEGIN'), /transactions are not supported/)
    await assert.rejects(db.exec('SELECT nope FROM t'), /no such column/)
    assert.throws(() => db.prepare('SELECT * FROM t; SELECT * FROM t'), /exactly one statement/)
    await assert.rejects(db.prepare('SELECT ?').bind().all(), /expects 1 bound parameter/)
    await assert.rejects(db.prepare('INSERT INTO t (nope) VALUES (?)').bind('x').run(), /no column/)
    await db.exec('CREATE TABLE u (id INTEGER)')
    await assert.rejects(db.exec('CREATE TABLE u (id INTEGER)'), /already exists/)
    await assert.rejects(db.exec('CREATE TABLE v ()'), /./)
    await assert.rejects(db.prepare('SELECT * FROM t WHERE id = ?').all(), /expects 1 bound parameter/)

    await db.prepare('INSERT INTO t (id) VALUES (?)').bind(1).run()
    const error = await db
      .prepare('INSERT INTO t (id) VALUES (?)')
      .bind(1)
      .run()
      .then(() => null)
      .catch((err: unknown) => err)
    assert.ok(error instanceof D1Error)
  } finally {
    await stop()
  }
})
