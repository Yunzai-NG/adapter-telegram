/**
 * 模块职责：平台标识、id 前缀的互转，以及消息 id 的编解码
 * 依赖方向：叶子模块
 * 生命周期：纯常量与纯函数
 * 注意事项：单独成文件的理由同 adapter-kook 的 platform.ts：codec / events / bot 都要用，
 *          从 `index.ts` 反向导入会把插件入口（`definePlugin` 的副作用）拖进测试的依赖图。
 *
 *          **一、用户 id 与群 id 一律带 `tg_` 前缀。** Telegram 的用户 id 是纯数字，与 QQ 号同形，
 *          而主人列表是跨平台的一张扁平表 —— 不加前缀，一个 Telegram 用户的 id 恰好等于某个
 *          QQ 号时，他在 QQ 侧也成了主人。群 id 保留 Telegram 的负号（`tg_-100123…`）。
 *
 *          **二、消息 id 是 `会话id:消息id`。** Telegram 的 message_id 只在一个会话内唯一，
 *          撤回（`deleteMessage`）与引用（`reply_parameters`）都要同时给出 chat_id。而内核的
 *          `recallMessage(messageId)` 只给一个字符串，故把会话 id 编进去。会话 id 可为负，
 *          消息 id 恒为正，所以按最后一个冒号切分。
 */

/** 平台标识，写进事件的 `e.platform` */
export const PLATFORM = "telegram"

/** 用户 id 与群 id 的前缀 */
export const ID_PREFIX = "tg_"

/**
 * 平台原始 id → 框架 id
 * @param raw Telegram 侧的原始 id
 * @returns 带前缀的 id；原值已带前缀时原样返回（幂等）
 */
export function toId(raw: string | number): string {
  const text = String(raw)
  return text.startsWith(ID_PREFIX) ? text : `${ID_PREFIX}${text}`
}

/**
 * 框架 id → 平台原始 id
 *
 * 不带前缀的值原样返回：插件可能直接拿原始的 chat_id 调发送，两种写法都应当可用。
 * @param id 框架 id
 * @returns Telegram 侧的原始 id
 */
export function fromId(id: string): string {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id
}

/**
 * 编码消息 id
 * @param chatId 会话原始 id
 * @param messageId 会话内消息 id
 * @returns `会话id:消息id`
 */
export function encodeMessageId(chatId: number | string, messageId: number): string {
  return `${chatId}:${messageId}`
}

/**
 * 解码消息 id
 *
 * 也接受不带会话部分的纯数字（插件手里只有 message_id 时），此时 `chatId` 为 undefined，
 * 由调用方用当前会话补齐。
 * @param id 编码后的消息 id
 * @returns 会话 id 与消息 id；认不出时 undefined
 */
export function decodeMessageId(id: string): { chatId?: string; messageId: number } | undefined {
  const cut = id.lastIndexOf(":")
  const head = cut === -1 ? undefined : fromId(id.slice(0, cut))
  const tail = Number(cut === -1 ? id : id.slice(cut + 1))
  if (!Number.isSafeInteger(tail) || tail <= 0) return undefined
  if (head === undefined) return { messageId: tail }
  if (!/^-?\d+$/.test(head) && !/^@\w+$/.test(head)) return undefined
  return { chatId: head, messageId: tail }
}
