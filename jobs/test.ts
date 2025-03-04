import { Job, log } from "@truto/truto-daemon"

class Test extends Job {
  async run(): Promise<void> {
    log.setBindings({
      job: 'Test',
    })
    log.info('This is the job output')
    try {
      const result = await this.sqlite
        .selectFrom('state')
        .selectAll()
        .where('key', '=', 'init_date')
        .execute()
      log.info(`Result: ${JSON.stringify(result)}`)
    } catch (err) {
      console.log(err)
    }
  }
}

new Test()
