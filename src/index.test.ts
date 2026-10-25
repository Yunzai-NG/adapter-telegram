/**
 * 模块职责：插件入口的测试 —— `setup()` 注册的适配器与命令、`#TG账号` 不泄露 token
 * 依赖方向：测试文件，依赖内核的公开测试替身（`@yunzai-ng/core/testing`）
 * 生命周期：每个用例一套全新的上下文
 * 注意事项：此处不测驱动的细节，那是 bot.test.ts 的事
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createEventBus, createPluginContext, createServiceRegistry, DisposalRegistry } from "@yunzai-ng/core"
import { fakeHttp, fakeLogger, recordingHooks } from "@yunzai-ng/core/testing"
import type { AccountState, AppView, ConfigHandle, KvNamespace, MessageEvent, PluginContext } from "@yunzai-ng/types"
import plugin, { ADAPTER_ID } from "./index.js"

/**
 * 装配一份上下文并跑一次 `setup()`
 * @param accounts 账号列表
 * @returns 录制到的注册结果
 */
function runSetup(accounts: AccountState[] = []): ReturnType<typeof recordingHooks>["recorded"] {
  const logger = fakeLogger()
  const { hooks, recorded } = recordingHooks()
  const { ctx } = createPluginContext({
    name: "adapter-telegram",
    version: "0.1.0",
    root: join(tmpdir(), "yzng-tg-plugin"),
    dataDir: join(tmpdir(), "yzng-tg-data"),
    logger,
    kv: {} as unknown as KvNamespace,
    config: {} as unknown as ConfigHandle<unknown>,
    app: { version: "0.0.0-test", startedAt: 0, accounts: { list: () => accounts } } as unknown as AppView,
    http: fakeHttp(),
    services: createServiceRegistry(),
    events: createEventBus({ logger }),
    hooks,
    registry: new DisposalRegistry("adapter-telegram"),
    signal: new AbortController().signal
  })
  plugin.setup(ctx as PluginContext<Record<string, never>>)
  return recorded
}

/**
 * 以一条消息触发命中的命令
 * @param recorded 录制结果
 * @param text 消息文本
 * @returns 回复的文本
 */
async function trigger(recorded: ReturnType<typeof recordingHooks>["recorded"], text: string): Promise<string[]> {
  const replies: string[] = []
  const command = recorded.commands.find(c => c.patterns.some(p => (typeof p === "string" ? text.startsWith(p) : p.test(text))))
  expect(command, `没有命令匹配 ${text}`).toBeDefined()
  const e = { text, reply: async (content: unknown) => void replies.push(String(content)) } as unknown as MessageEvent
  await command!.handler!(e)
  return replies
}

describe("插件入口", () => {
  it("适配器 id 与平台", () => {
    // 账号记录里存的是这个 id；改名会让已有账号全部指不到适配器
    expect(ADAPTER_ID).toBe("telegram")
    expect(plugin.name).toBe("adapter-telegram")
    expect(plugin.priority).toBe(10)
    const recorded = runSetup()
    expect(recorded.adapters.map(a => [a.id, a.platform])).toEqual([["telegram", "telegram"]])
  })

  it("账号表单的 token 字段是密文", () => {
    const [provider] = runSetup().adapters
    const token = provider!.accountSchema.properties?.["token"]
    expect(token).toMatchObject({ secret: true })
  })

  it("#TG账号 列出状态，token 脱敏", async () => {
    const recorded = runSetup([
      {
        record: { id: "a1", adapterId: "telegram", enabled: true, config: { token: "123456:SECRET-PART-xyz" }, selfId: "tg_123456", createdAt: 0, updatedAt: 0 },
        status: "online",
        since: 0,
        nickname: "小助手",
        retries: 0
      },
      { record: { id: "a2", adapterId: "kook", enabled: true, config: {}, createdAt: 0, updatedAt: 0 }, status: "online", since: 0, retries: 0 }
    ])
    const [reply] = await trigger(recorded, "#TG账号")
    expect(reply).toContain("共 1 个 Telegram 账号")
    expect(reply).toContain("小助手（tg_123456）：在线")
    expect(reply).not.toContain("SECRET-PART")
  })

  it("#TG设置 / #tg代理 只回面板指引", async () => {
    const recorded = runSetup()
    expect((await trigger(recorded, "#TG设置123:abc"))[0]).toMatch(/面板.*\/revoke/s)
    expect((await trigger(recorded, "#tg代理http://127.0.0.1:7890"))[0]).toMatch(/面板/)
  })
})
