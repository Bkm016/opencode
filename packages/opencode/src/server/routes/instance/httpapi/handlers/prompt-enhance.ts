import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { SessionEnhance } from "@/session/enhance"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { InstanceHttpApi } from "../api"
import { EnhancePayload } from "../groups/prompt-enhance"

const ENHANCE_AGENT: Agent.Info = {
  name: "prompt-enhance",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  // 智能体自带 prompt 时不会再拼默认的 OpenCode 系统提示词
  prompt: SessionEnhance.SYSTEM,
}

export const promptEnhanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "promptEnhance", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service

    // 优先 small_model（和生成标题同一个），没有就用当前输入框选的模型
    const pickModel = Effect.fn("PromptEnhanceHttpApi.pickModel")(function* (
      selected: typeof EnhancePayload.Type.model,
    ) {
      const fallback = selected
        ? { providerID: ProviderV2.ID.make(selected.providerID), modelID: ModelV2.ID.make(selected.modelID) }
        : yield* provider.defaultModel()
      return (
        (yield* provider.getSmallModel(fallback.providerID)) ??
        (yield* provider.getModel(fallback.providerID, fallback.modelID))
      )
    })

    const history = Effect.fn("PromptEnhanceHttpApi.history")(function* (sessionID: string | undefined) {
      if (!sessionID) return ""
      const messages = yield* sessions
        .messages({ sessionID: SessionID.make(sessionID), limit: SessionEnhance.RECENT })
        .pipe(Effect.catch(() => Effect.succeed([])))
      return SessionEnhance.transcript(messages)
    })

    const enhance = Effect.fn("PromptEnhanceHttpApi.enhance")(function* (payload: typeof EnhancePayload.Type) {
      const model = yield* pickModel(payload.model)
      const context = yield* history(payload.sessionID)
      const sessionID = SessionID.descending()
      return llm
        .stream({
          agent: ENHANCE_AGENT,
          user: {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: ENHANCE_AGENT.name,
            model: { providerID: model.providerID, modelID: model.id },
          },
          system: [],
          small: true,
          tools: {},
          model,
          sessionID,
          retries: 2,
          messages: [{ role: "user", content: SessionEnhance.request(payload.text, context) }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
        )
    })

    return handlers.handle("enhance", (ctx) =>
      Effect.gen(function* () {
        const text = ctx.payload.text.trim()
        const stream = text
          ? yield* enhance({ ...ctx.payload, text }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("prompt enhance failed", { cause }).pipe(Effect.as(Stream.empty)),
              ),
            )
          : Stream.empty
        // 响应体在 handler 返回后才被消费，要把当前实例上下文带进去
        const context = yield* Effect.context<never>()
        // 出错时直接结束，前端拿到空结果就保留原文
        return HttpServerResponse.stream(
          stream.pipe(
            Stream.provideContext(context),
            Stream.catchCause((cause) =>
              Stream.fromEffect(Effect.logWarning("prompt enhance stream failed", { cause })).pipe(Stream.drain),
            ),
            Stream.encodeText,
          ),
          { contentType: "text/plain; charset=utf-8" },
        )
      }),
    )
  }),
)
