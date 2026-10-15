import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { SessionEnhance } from "@/session/enhance"
import { SessionSuggest } from "@/session/suggest"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { SuggestPayload } from "../groups/prompt-suggest"

export const promptSuggestHandlers = HttpApiBuilder.group(InstanceHttpApi, "promptSuggest", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service

    // 与提示词优化一致：suggest 智能体单独配置的模型 > small_model > 输入框当前模型
    const pickModel = Effect.fn("PromptSuggestHttpApi.pickModel")(function* (
      agent: Agent.Info,
      selected: typeof SuggestPayload.Type.model,
    ) {
      if (agent.model) return yield* provider.getModel(agent.model.providerID, agent.model.modelID)
      const fallback = selected
        ? { providerID: ProviderV2.ID.make(selected.providerID), modelID: ModelV2.ID.make(selected.modelID) }
        : yield* provider.defaultModel()
      return (
        (yield* provider.getSmallModel(fallback.providerID)) ??
        (yield* provider.getModel(fallback.providerID, fallback.modelID))
      )
    })

    const suggest = Effect.fn("PromptSuggestHttpApi.suggest")(function* (
      sessionID: string,
      selected: typeof SuggestPayload.Type.model,
    ) {
      const agent = yield* agents.get("suggest")
      if (!agent) return undefined
      const messages = yield* sessions.messages({
        sessionID: SessionID.make(sessionID),
        limit: SessionEnhance.RECENT,
      })
      // 最后一条必须是助手回复；用户刚发完话、还没回复时没有可建议的
      if (messages.at(-1)?.info.role !== "assistant") return undefined
      const history = SessionEnhance.transcript(messages, { notices: true })
      if (!history) return undefined
      const model = yield* pickModel(agent, selected)
      const scratch = SessionID.descending()
      const output = yield* llm
        .stream({
          agent,
          user: {
            id: MessageID.ascending(),
            sessionID: scratch,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: model.providerID, modelID: model.id },
          },
          system: [],
          small: true,
          tools: {},
          model,
          sessionID: scratch,
          retries: 1,
          messages: [{ role: "user", content: SessionSuggest.request(history) }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.runCollect,
          Effect.map((chunks) => Array.from(chunks).join("")),
        )
      return SessionSuggest.clean(output)
    })

    return handlers.handle("suggest", (ctx) =>
      suggest(ctx.params.sessionID, ctx.payload.model).pipe(
        Effect.map((text) => ({ text })),
        // 建议是锦上添花：任何失败都当作没有建议，不打扰用户
        Effect.catchCause((cause) =>
          Effect.logWarning("prompt suggest failed", { cause }).pipe(Effect.as({ text: undefined })),
        ),
      ),
    )
  }),
)
