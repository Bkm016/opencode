import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Question } from "@/question"
import { SessionEnhance } from "@/session/enhance"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Queue, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { InstanceHttpApi } from "../api"
import { EnhancePayload } from "../groups/prompt-enhance"

export const promptEnhanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "promptEnhance", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const question = yield* Question.Service

    // 优先 enhance 智能体单独配置的模型，其次 small_model（和生成标题同一个），最后用当前输入框选的模型
    const pickModel = Effect.fn("PromptEnhanceHttpApi.pickModel")(function* (
      agent: Agent.Info,
      selected: typeof EnhancePayload.Type.model,
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

    const history = Effect.fn("PromptEnhanceHttpApi.history")(function* (sessionID: string | undefined) {
      if (!sessionID) return ""
      const messages = yield* sessions
        .messages({ sessionID: SessionID.make(sessionID), limit: SessionEnhance.RECENT })
        .pipe(Effect.catch(() => Effect.succeed([])))
      return SessionEnhance.transcript(messages)
    })

    const enhance = Effect.fn("PromptEnhanceHttpApi.enhance")(function* (payload: typeof EnhancePayload.Type) {
      const agent = yield* agents.get("enhance")
      if (!agent) return Stream.empty
      const model = yield* pickModel(agent, payload.model)
      const context = yield* history(payload.sessionID)
      const sessionID = SessionID.descending()
      const generate = (content: string) =>
        llm
          .stream({
            agent,
            user: {
              id: MessageID.ascending(),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: agent.name,
              model: { providerID: model.providerID, modelID: model.id },
            },
            system: [],
            small: true,
            tools: {},
            model,
            sessionID,
            retries: 2,
            messages: [{ role: "user", content }],
          })
          .pipe(
            Stream.filter(LLMEvent.is.textDelta),
            Stream.map((event) => event.text),
          )

      return Stream.callback<string, unknown>((queue) =>
        Effect.gen(function* () {
          // 开头像 <questions> 时先攒着；确认是改写结果就直接往外流
          let head = ""
          let streaming = false
          yield* generate(
            SessionEnhance.request(payload.text, context, { answers: payload.answers, ask: !!payload.sessionID }),
          ).pipe(
            Stream.runForEach((chunk) => {
              if (streaming) return Queue.offer(queue, chunk)
              head += chunk
              const start = head.trimStart()
              if (SessionEnhance.QUESTIONS_TAG.startsWith(start) || start.startsWith(SessionEnhance.QUESTIONS_TAG))
                return Effect.void
              streaming = true
              return Queue.offer(queue, head)
            }),
          )
          const questions = streaming ? undefined : SessionEnhance.parseQuestions(head)
          if (!streaming && !questions && !head.trimStart().startsWith(SessionEnhance.QUESTIONS_TAG))
            yield* Queue.offer(queue, head)
          if (questions) {
            // 复用会话的提问弹窗；用户忽略就按未回答处理，直接改写
            const replies = payload.sessionID
              ? yield* question
                  .ask({
                    sessionID: SessionID.make(payload.sessionID),
                    questions: questions.map((item) => ({
                      question: item.question,
                      header: item.question.length > 30 ? item.question.slice(0, 29) + "…" : item.question,
                      options: item.options.map((label) => ({ label, description: "" })),
                      custom: true,
                    })),
                  })
                  .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<Question.Answer>)))
              : []
            const answers = questions.map((item, index) => ({
              question: item.question,
              answer: (replies[index] ?? []).join(", "),
            }))
            yield* generate(SessionEnhance.request(payload.text, context, { answers })).pipe(
              Stream.runForEach((chunk) => Queue.offer(queue, chunk)),
            )
          }
          yield* Queue.end(queue)
        }),
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
