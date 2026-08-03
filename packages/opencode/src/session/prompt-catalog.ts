import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_META from "./prompt/meta.txt"
import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

import GOAL_CONTRACT from "./prompt/goal-contract.txt"
import SUBAGENT_WORKSPACE from "./prompt/subagent-workspace.txt"

import PROMPT_COMPACTION from "../agent/prompt/compaction.txt"
import PROMPT_EXPLORE from "../agent/prompt/explore.txt"
import PROMPT_SUMMARY from "../agent/prompt/summary.txt"
import PROMPT_TITLE from "../agent/prompt/title.txt"
import PROMPT_GENERATE from "../agent/generate.txt"

import PROMPT_INITIALIZE from "../command/template/initialize.txt"
import PROMPT_REVIEW from "../command/template/review.txt"

import TOOL_READ from "../tool/read.txt"
import TOOL_WRITE from "../tool/write.txt"
import TOOL_EDIT from "../tool/edit.txt"
import TOOL_GREP from "../tool/grep.txt"
import TOOL_GLOB from "../tool/glob.txt"
import TOOL_TASK from "../tool/task.txt"
import TOOL_SKILL from "../tool/skill.txt"
import TOOL_QUESTION from "../tool/question.txt"
import TOOL_LSP from "../tool/lsp.txt"
import TOOL_WEBFETCH from "../tool/webfetch.txt"
import TOOL_WEBSEARCH from "../tool/websearch.txt"
import TOOL_TODOWRITE from "../tool/todowrite.txt"
import TOOL_APPLY_PATCH from "../tool/apply_patch.txt"
import TOOL_PLAN_EXIT from "../tool/plan-exit.txt"
import TOOL_SHELL from "../tool/shell/shell.txt"
import TOOL_PYTHON from "../tool/python.txt"

import TOOL_GOAL_UPDATE from "../tool/goal-update.txt"
import TOOL_GOAL_LESSON_ADD from "../tool/goal-lesson-add.txt"

import { SUMMARY_TEMPLATE } from "@opencode-ai/core/session/compaction"

export type PromptGroup =
  | "system"
  | "agent"
  | "session"
  | "tool"
  | "command"
  | "compaction"
  | "runtime"

export type PromptEntry = {
  id: string
  group: PromptGroup
  title: string
  description: string
  default: string
}

const DEFAULT_FRESH_INTRO = "Create a new anchored summary from the conversation history."
const DEFAULT_UPDATE_INTRO = `Update the anchored summary below using the conversation history above.
Preserve still-true details, remove stale details, and merge in the new facts.
<previous-summary>
\${previousSummary}
</previous-summary>`

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`

const BUILD_SYSTEM =
  "You are an AI coding agent. Help the user accomplish software engineering tasks by inspecting the workspace, making targeted changes, and using tools according to the configured permissions."

export const ENTRIES: readonly PromptEntry[] = [
  {
    id: "system.default",
    group: "system",
    title: "Default system",
    description: "Provider system prompt for models without a specialized template",
    default: PROMPT_DEFAULT,
  },
  {
    id: "system.anthropic",
    group: "system",
    title: "Anthropic / Claude",
    description: "System prompt when the model id includes claude",
    default: PROMPT_ANTHROPIC,
  },
  {
    id: "system.gpt",
    group: "system",
    title: "GPT",
    description: "System prompt for gpt models (non-codex)",
    default: PROMPT_GPT,
  },
  {
    id: "system.beast",
    group: "system",
    title: "GPT-4 / o1 / o3",
    description: "System prompt for gpt-4, o1, and o3 models",
    default: PROMPT_BEAST,
  },
  {
    id: "system.codex",
    group: "system",
    title: "Codex",
    description: "System prompt when the model id includes codex",
    default: PROMPT_CODEX,
  },
  {
    id: "system.gemini",
    group: "system",
    title: "Gemini",
    description: "System prompt when the model id includes gemini-",
    default: PROMPT_GEMINI,
  },
  {
    id: "system.kimi",
    group: "system",
    title: "Kimi",
    description: "System prompt when the model id includes kimi",
    default: PROMPT_KIMI,
  },
  {
    id: "system.meta",
    group: "system",
    title: "Meta / Muse Spark",
    description: "System prompt when the model id includes muse-spark",
    default: PROMPT_META,
  },
  {
    id: "system.trinity",
    group: "system",
    title: "Trinity",
    description: "System prompt when the model id includes trinity",
    default: PROMPT_TRINITY,
  },
  {
    id: "agent.build",
    group: "agent",
    title: "Build agent",
    description: "Default primary agent system prompt (used when agent.prompt is set)",
    default: BUILD_SYSTEM,
  },
  {
    id: "agent.explore",
    group: "agent",
    title: "Explore agent",
    description: "Subagent specialized for codebase search",
    default: PROMPT_EXPLORE,
  },
  {
    id: "agent.compaction",
    group: "agent",
    title: "Compaction agent",
    description: "Hidden agent system prompt for context compaction",
    default: PROMPT_COMPACTION,
  },
  {
    id: "agent.title",
    group: "agent",
    title: "Title agent",
    description: "Hidden agent that generates session titles",
    default: PROMPT_TITLE,
  },
  {
    id: "agent.summary",
    group: "agent",
    title: "Summary agent",
    description: "Hidden agent that summarizes completed work",
    default: PROMPT_SUMMARY,
  },
  {
    id: "agent.generate",
    group: "agent",
    title: "Generate agent config",
    description: "Prompt used when creating a new agent configuration from a description",
    default: PROMPT_GENERATE,
  },
  {
    id: "session.plan",
    group: "session",
    title: "Plan mode injection",
    description: "Synthetic user text injected while the plan agent is active",
    default: PROMPT_PLAN,
  },
  {
    id: "session.plan_mode",
    group: "session",
    title: "Plan mode (experimental)",
    description: "Experimental plan-mode body; supports ${planInfo}",
    default: PLAN_MODE,
  },
  {
    id: "session.build_switch",
    group: "session",
    title: "Plan → build switch",
    description: "Synthetic text injected when leaving plan agent for build",
    default: BUILD_SWITCH,
  },
  {
    id: "command.init",
    group: "command",
    title: "/init command",
    description: "Built-in initialize command template; supports ${path}",
    default: PROMPT_INITIALIZE,
  },
  {
    id: "command.review",
    group: "command",
    title: "/review command",
    description: "Built-in review command template; supports ${path}",
    default: PROMPT_REVIEW,
  },
  {
    id: "tool.read",
    group: "tool",
    title: "read",
    description: "Tool description for the read tool",
    default: TOOL_READ,
  },
  {
    id: "tool.write",
    group: "tool",
    title: "write",
    description: "Tool description for the write tool",
    default: TOOL_WRITE,
  },
  {
    id: "tool.edit",
    group: "tool",
    title: "edit",
    description: "Tool description for the edit tool",
    default: TOOL_EDIT,
  },
  {
    id: "tool.grep",
    group: "tool",
    title: "grep",
    description: "Tool description for the grep tool",
    default: TOOL_GREP,
  },
  {
    id: "tool.glob",
    group: "tool",
    title: "glob",
    description: "Tool description for the glob tool",
    default: TOOL_GLOB,
  },
  {
    id: "tool.task",
    group: "tool",
    title: "task",
    description: "Tool description for the task tool",
    default: TOOL_TASK,
  },
  {
    id: "tool.skill",
    group: "tool",
    title: "skill",
    description: "Tool description for the skill tool",
    default: TOOL_SKILL,
  },
  {
    id: "tool.question",
    group: "tool",
    title: "question",
    description: "Tool description for the question tool",
    default: TOOL_QUESTION,
  },
  {
    id: "tool.lsp",
    group: "tool",
    title: "lsp",
    description: "Tool description for the lsp tool",
    default: TOOL_LSP,
  },
  {
    id: "tool.webfetch",
    group: "tool",
    title: "webfetch",
    description: "Tool description for the webfetch tool",
    default: TOOL_WEBFETCH,
  },
  {
    id: "tool.websearch",
    group: "tool",
    title: "websearch",
    description: "Tool description for the websearch tool",
    default: TOOL_WEBSEARCH,
  },
  {
    id: "tool.todowrite",
    group: "tool",
    title: "todowrite",
    description: "Tool description for the todowrite tool",
    default: TOOL_TODOWRITE,
  },
  {
    id: "tool.apply_patch",
    group: "tool",
    title: "apply_patch",
    description: "Tool description for the apply_patch tool",
    default: TOOL_APPLY_PATCH,
  },
  {
    id: "tool.plan_exit",
    group: "tool",
    title: "plan_exit",
    description: "Tool description for the plan_exit tool",
    default: TOOL_PLAN_EXIT,
  },
  {
    id: "tool.bash",
    group: "tool",
    title: "bash / shell",
    description: "Shell tool description template (supports placeholder tokens from the shell renderer)",
    default: TOOL_SHELL,
  },
  {
    id: "tool.python",
    group: "tool",
    title: "python",
    description: "Tool description for the python tool",
    default: TOOL_PYTHON,
  },
  {
    id: "tool.goal_update",
    group: "tool",
    title: "goal_update",
    description: "Tool description for the goal_update tool",
    default: TOOL_GOAL_UPDATE,
  },
  {
    id: "tool.goal_lesson_add",
    group: "tool",
    title: "goal_lesson_add",
    description: "Tool description for the goal_lesson_add tool",
    default: TOOL_GOAL_LESSON_ADD,
  },
  {
    id: "session.subagent_workspace",
    group: "session",
    title: "Subagent shared workspace safety",
    description: "Injected into every provider turn of a child session to preserve concurrent worktree changes",
    default: SUBAGENT_WORKSPACE,
  },
  {
    id: "session.goal_contract",
    group: "session",
    title: "Goal contract",
    description: "Injected into provider steps when an active Goal exists; supports ${outcome}, ${verification}, ${constraints}, ${boundaries}, ${iterationPolicy}, ${tokenBudget}",
    default: GOAL_CONTRACT,
  },
  {
    id: "compaction.template",
    group: "compaction",
    title: "Compaction summary template",
    description: "Markdown structure the compaction model must follow",
    default: SUMMARY_TEMPLATE,
  },
  {
    id: "compaction.fresh_intro",
    group: "compaction",
    title: "Compaction fresh intro",
    description: "User prompt intro when there is no previous summary",
    default: DEFAULT_FRESH_INTRO,
  },
  {
    id: "compaction.update_intro",
    group: "compaction",
    title: "Compaction update intro",
    description: "User prompt intro when merging into a previous summary; supports ${previousSummary}",
    default: DEFAULT_UPDATE_INTRO,
  },
  {
    id: "runtime.structured_output_system",
    group: "runtime",
    title: "Structured output system",
    description: "System reminder when the user requested structured JSON output",
    default: STRUCTURED_OUTPUT_SYSTEM_PROMPT,
  },
  {
    id: "runtime.structured_output_tool",
    group: "runtime",
    title: "Structured output tool",
    description: "Description of the StructuredOutput tool",
    default: STRUCTURED_OUTPUT_DESCRIPTION,
  },
  {
    id: "runtime.max_steps",
    group: "runtime",
    title: "Max steps reached",
    description: "Message injected when an agent hits its step limit",
    default: MAX_STEPS_PROMPT,
  },
]

const byId = new Map(ENTRIES.map((entry) => [entry.id, entry]))

export function getDefault(id: string) {
  return byId.get(id)?.default
}

export function resolve(id: string, overrides?: Record<string, string | undefined> | null) {
  const fallback = getDefault(id) ?? ""
  const next = overrides?.[id]
  if (next === undefined || next === "") return fallback
  return next
}

export function catalog(overrides?: Record<string, string | undefined> | null) {
  return ENTRIES.map((entry) => {
    const value = resolve(entry.id, overrides)
    return {
      id: entry.id,
      group: entry.group,
      title: entry.title,
      description: entry.description,
      default: entry.default,
      value,
      overridden: value !== entry.default,
    }
  })
}

export * as PromptCatalog from "./prompt-catalog"
