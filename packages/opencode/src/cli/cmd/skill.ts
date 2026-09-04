import { SkillCloud } from "@opencode-ai/core/skill-cloud"
import { Effect } from "effect"
import { EOL } from "node:os"
import { effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"

const output = (value: unknown) => {
  process.stdout.write(JSON.stringify(value, null, 2) + EOL)
}

const result = <A>(effect: Effect.Effect<A, SkillCloud.OperationError>) =>
  effect.pipe(Effect.catch((error) => fail(error.detail)))

const CloudListCommand = effectCmd({
  command: "list",
  describe: "list all cloud skill repositories",
  instance: false,
  handler: Effect.fn("Cli.skill.cloud.list")(function* () {
    const cloud = yield* SkillCloud.Service
    output(yield* result(cloud.list()))
  }),
})

const CloudStatusCommand = effectCmd({
  command: "status",
  describe: "show cloud skill repository status",
  instance: false,
  builder: (yargs) =>
    yargs.option("name", {
      alias: "n",
      type: "string",
      describe: "repository name",
    }),
  handler: Effect.fn("Cli.skill.cloud.status")(function* (args) {
    const cloud = yield* SkillCloud.Service
    output(yield* result(cloud.status(args.name)))
  }),
})

const CloudConfigureCommand = effectCmd({
  command: "configure <repository>",
  describe: "configure or add a cloud skill Git repository",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("repository", {
        type: "string",
        describe: "Git repository URL",
        demandOption: true,
      })
      .option("name", {
        alias: "n",
        type: "string",
        describe: "repository name/identifier",
      }),
  handler: Effect.fn("Cli.skill.cloud.configure")(function* (args) {
    const cloud = yield* SkillCloud.Service
    output(yield* result(cloud.configure({ repository: args.repository, name: args.name })))
  }),
})

const CloudUpdateCommand = effectCmd({
  command: "update",
  describe: "fetch and fast-forward cloud skills",
  instance: false,
  builder: (yargs) =>
    yargs.option("name", {
      alias: "n",
      type: "string",
      describe: "repository name (updates all if omitted)",
    }),
  handler: Effect.fn("Cli.skill.cloud.update")(function* (args) {
    const cloud = yield* SkillCloud.Service
    output(yield* result(cloud.update({ name: args.name })))
  }),
})

const CloudSyncCommand = effectCmd({
  command: "sync",
  describe: "commit and push cloud skill changes",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("name", {
        alias: "n",
        type: "string",
        describe: "repository name",
      })
      .option("message", {
        alias: "m",
        type: "string",
        describe: "commit message",
      }),
  handler: Effect.fn("Cli.skill.cloud.sync")(function* (args) {
    const cloud = yield* SkillCloud.Service
    output(yield* result(cloud.sync({ name: args.name, message: args.message })))
  }),
})

const CloudRemoveCommand = effectCmd({
  command: "remove <name>",
  describe: "remove a cloud skill repository",
  instance: false,
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "repository name to remove",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.skill.cloud.remove")(function* (args) {
    const cloud = yield* SkillCloud.Service
    output(yield* result(cloud.remove({ name: args.name })))
  }),
})

const CloudCommand = cmd({
  command: "cloud",
  describe: "manage cloud skill repositories",
  builder: (yargs) =>
    yargs
      .command(CloudListCommand)
      .command(CloudStatusCommand)
      .command(CloudConfigureCommand)
      .command(CloudUpdateCommand)
      .command(CloudSyncCommand)
      .command(CloudRemoveCommand)
      .demandCommand(),
  async handler() {},
})

export const SkillCommand = cmd({
  command: "skill",
  describe: "manage skills",
  builder: (yargs) => yargs.command(CloudCommand).demandCommand(),
  async handler() {},
})
