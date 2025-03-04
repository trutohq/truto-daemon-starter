# Truto Daemon Starter Kit

This is a starter kit for creating a Truto Daemon. It uses [Bun.sh](https://bun.sh/).

## Installation

1. Install [Bun.sh](https://bun.sh/).
2. Install dependencies using `bun install`
3. Copy the .env.example to .env and change the values to your own. Refer the section below on Environment variables.
4. Run the Daemon using `bun dev`. It will poll for Daemon Jobs on Truto and run them.

## SQLite

It uses SQLite as a persistent store and is stored at <project_root>/sqlite.db by default. To change the location, you can use the `SQLITE_DB_PATH` environment variable.

### Migrations

The library uses Kysely as an ORM and uses it's migrations feature. By default, the migrations are checked for in the `migrations` folder. You can change the location by using the `TRUTO_MIGRATION_FOLDER` environment variable.

The migrations run when the library is started. If the database is not present, it will create it and run all the migrations.

By default, there is a migration which creates the `state` table, which is basically a key-value store for storing the state of the jobs across multiple runs.

## Jobs

Jobs are created in Truto and are stored in the `jobs` folder. The library will look for jobs in this folder by default. You can change the location by using the `TRUTO_JOB_FOLDER` environment variable.

A job is basically a class which extends the abstract Job class. It needs to define a `run()` method which has all the data syncing logic.

There is a `test` job in the `jobs` folder which just prints the date at which the `state` table was created. 

## Deployment

There is a deploy.sh script which can be used to deploy the daemon to a server using SSH and systemd. It creates a persistent process with auto-restart capabilities and logging to syslog.

First create the executable,

```bash
bun run build-linux
```

and then run the deploy script with the following arguments,

```bash
./deploy.sh root 192.168.0.1
```

Where `root` is the name of the user used for SSH followed by the IP address of the machine you want to deploy to.

The script will copy over the following things to the server,

- truto-daemon executable
- `.env` file
- `jobs` folder
- `migrations` folder

## Environment variables

All the environment variables are listed in .env.example.

- `TRUTO_DAEMON_ID` - **Required**. The ID of the Daemon in Truto.
- `TRUTO_API_TOKEN` - **Required**. [API token](https://truto.one/docs/guides/api-tokens/creating-api-tokens) to authenticate with Truto.
- `SQLITE_DB_PATH` - Optional. Path to the SQLite database file. Defaults to `sqlite.db`.
- `TRUTO_MIGRATION_FOLDER` - Optional. Path to the folder where migrations are stored. Defaults to `migrations`.
- `TRUTO_JOB_FOLDER` - Optional. Path to the folder where jobs are stored. Defaults to `jobs`.
- `TRUTO_API_BASE_URL` - Optional. Defaults to https://api.truto.one.
