/**
 * 模块职责：插件入口 —— 将 Telegram 适配器注册至内核，并提供一条查看账号状态的主人命令
 * 依赖方向：仅依赖 `@yunzai-ng/core` 的公开入口与 `@yunzai-ng/types`
 * 生命周期：`setup` 在插件加载时执行一次，返回后适配器即可被账号引用
 * 注意事项：**账号经面板添加，不经聊天命令。** 账号由内核统一管理（启停、重连、状态展示），
 *          代理与 API 基址是每个账号自己的字段。`#TG设置` / `#TG代理` / `#TG反代` 只回一句
 *          去面板改的指引 —— 不在聊天里接收 token；`#TG账号` 列出各账号的在线状态（token 脱敏）。
 *
 *          **未实现 `login()`。** Telegram 机器人没有交互式登录，@BotFather 给的 token 即是全部。
 */
import { definePlugin, maskSecret } from "@yunzai-ng/core"
import type { AdapterHost, AdapterProvider, BotDriver, PluginDefinition } from "@yunzai-ng/types"
import { ACCOUNT_SCHEMA, validateAccount } from "./config.js"
import type { TelegramAccount } from "./config.js"
import { createTelegramBot } from "./bot.js"
import { PLATFORM } from "./platform.js"

/** 适配器 id；账号记录中引用该值 */
export const ADAPTER_ID = "telegram"

/** 账号状态的中文说明 */
const STATUS_TEXT: Readonly<Record<string, string>> = {
  online: "在线",
  connecting: "连接中",
  offline: "离线",
  error: "出错",
  disabled: "已停用"
}

export { ACCOUNT_SCHEMA, validateAccount } from "./config.js"
export type { TelegramAccount } from "./config.js"
export { PLATFORM, ID_PREFIX, toId, fromId, encodeMessageId, decodeMessageId } from "./platform.js"

/**
 * 插件定义
 *
 * 显式标注类型的理由同 adapter-napcat：避免就地构建时 .d.ts 指称宿主 `.pnpm` 路径（TS2742）。
 */
const plugin: PluginDefinition<Record<string, never>> = definePlugin({
  name: "adapter-telegram",
  version: "0.1.0",
  description: "Telegram 机器人适配器：Bot API 长轮询接入，私聊与群聊收发、图片 / 语音 / 视频 / 文件、内联按钮",
  // 与其他适配器一致：注册越早，"适配器未注册"的时间窗口越短
  priority: 10,

  setup(ctx) {
    const provider: AdapterProvider<TelegramAccount> = {
      id: ADAPTER_ID,
      name: "Telegram",
      description: "连接一个 Telegram 机器人。找 @BotFather 创建机器人、复制 token 填入；国内网络需要填代理",
      platform: PLATFORM,
      accountSchema: ACCOUNT_SCHEMA.describe(),
      validateAccount,

      createBot(account: TelegramAccount, host: AdapterHost): BotDriver {
        return createTelegramBot(account, host, { adapterId: ADAPTER_ID, http: ctx.http })
      }
    }

    ctx.registerAdapter(provider as unknown as AdapterProvider)

    // 触发词 `#TG` / `#tg` 均可
    ctx
      .command(/^#[Tt][Gg]账号$/, { desc: "列出 Telegram 账号及其在线状态", usage: "#TG账号", master: true })
      .action(async e => {
        const list = ctx.app.accounts.list().filter(state => state.record.adapterId === ADAPTER_ID)
        if (list.length === 0) {
          await e.reply("还没有 Telegram 账号。请在面板的账号页添加（适配器选「Telegram」）", { quote: true })
          return
        }
        const lines = list.map(state => {
          const token = typeof state.record.config["token"] === "string" ? maskSecret(state.record.config["token"]) : "-"
          const who = state.nickname ?? state.record.label ?? state.record.selfId ?? state.record.id.slice(0, 8)
          const status = STATUS_TEXT[state.status] ?? state.status
          return `${who}（${state.record.selfId ?? "未连接过"}）：${status}${state.error === undefined ? "" : `，${state.error}`}\n  Token ${token}`
        })
        await e.reply(`共 ${list.length} 个 Telegram 账号：\n${lines.join("\n")}`, { quote: true })
      })

    ctx
      .command(/^#[Tt][Gg](设置|代理|反代).*$/, { desc: "（已改为在面板管理 Telegram 账号）", usage: "#TG设置", master: true, hidden: true })
      .action(async e => {
        // 不在聊天里接收 token：它会留在聊天记录、消息日志与平台服务器上
        const isToken = /^#[Tt][Gg]设置/.test(e.text)
        await e.reply(
          "账号改由面板管理：打开面板 → 账号 → 添加账号 → 适配器选「Telegram」，填入 Bot Token 保存即可；" +
            "代理与反代（API 基址）是每个账号自己的设置，在同一个表单的「连接」分组里。" +
            (isToken ? "\n刚才这条消息里若带了 Token，建议到 @BotFather 用 /revoke 重置一次。" : ""),
          { quote: true }
        )
      })

    ctx.logger.info("Telegram 适配器已注册，可在面板的账号页面添加账号")
  }
})

export default plugin
