import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import { PromptCatalog } from "@/session/prompt-catalog"
import { Instruction } from "@/session/instruction"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const instructionSvc = yield* Instruction.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    const prompts = Effect.fn("ConfigHttpApi.prompts")(function* () {
      const cfg = yield* configSvc.get()
      return PromptCatalog.catalog(cfg.prompts)
    })

    const instructions = Effect.fn("ConfigHttpApi.instructions")(function* () {
      return yield* instructionSvc.systemEntries().pipe(
        Effect.mapError(() => new HttpApiError.InternalServerError({})),
      )
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("providers", providers)
      .handle("prompts", prompts)
      .handle("instructions", instructions)
  }),
)
