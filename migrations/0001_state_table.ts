import { Kysely, sql } from 'kysely'
import { DateTime } from 'luxon'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('state')
    .addColumn('key', 'text', (col: { primaryKey: () => any }) =>
      col.primaryKey()
    )
    .addColumn('value', 'text')
    .addColumn('metadata', 'text')
    .addColumn('created_at', 'datetime', col =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('updated_at', 'datetime', col =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute()
  await db
    .insertInto('state')
    .values({
      key: 'init_date',
      value: DateTime.now().toISO(),
    })
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('state').execute()
}
