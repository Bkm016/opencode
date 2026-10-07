import type { Agent } from "@opencode-ai/sdk/v2/client"

// 智能体列表还没拿到（首次安装、实例启动慢或请求失败）时先用内置的 build，不卡发送；拿到真实列表后自动替换
export const FALLBACK_AGENTS: Agent[] = [{ name: "build", mode: "primary", native: true, permission: [], options: {} }]

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}
