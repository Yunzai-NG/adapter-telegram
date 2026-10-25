/**
 * 模块职责：Telegram 更新（`Update`）→ 内核事件（`IncomingEvent`）
 * 依赖方向：依赖 callback / decode / platform / types 与类型包
 * 生命周期：纯函数；需要查平台的部分（群角色、按钮长数据）经注入的 `EventContext` 完成
 * 注意事项：**一、supergroup 与 group 都按"群"投递。** 频道（channel）的帖子是另一种
 *          更新（`channel_post`），不订阅：频道里没有"用户发言"，命令插件在那里无事可做。
 *
 *          **二、群消息要带角色。** `e.isGroupAdmin` 靠 `sender.role` 判定，而消息里不带发送者的
 *          群身份 —— 由 `EventContext.roleOf()` 查管理员列表（bot.ts 里带缓存）。匿名管理员以群自身的
 *          身份发言（`sender_chat.id === chat.id`），直接判为 admin。
 *
 *          **三、按钮点击是一条消息。** 与 adapter-kook 的约定一致：`send` 动作当作该用户发了这句话
 *          （`subType: "button"`，`quote` 指向按钮所在的消息）；`prompt` 动作不投递，只弹窗提示。
 *          两者都要 `answerCallbackQuery`，否则客户端的按钮会一直转圈。
 */
import type { IncomingEvent, IncomingMessageEvent, GroupInfo, GroupRole, MemberInfo, UserInfo } from "@yunzai-ng/types"
import { decodeCallback } from "./callback.js"
import type { ButtonAction } from "./callback.js"
import { chatAsUser, decodeMessage, decodeQuote, displayName, toUser } from "./decode.js"
import type { DecodeContext } from "./decode.js"
import { encodeMessageId, toId } from "./platform.js"
import type { TgCallbackQuery, TgChat, TgMessage, TgUpdate, TgUser } from "./types.js"

/** 解码时需要的平台查询 */
export interface EventContext extends DecodeContext {
  /**
   * 查成员在群里的角色；应带缓存
   * @param chatId 群原始 id
   * @param userId 用户原始 id
   * @returns 角色
   */
  roleOf(chatId: number, userId: number): Promise<GroupRole>
  /**
   * 取按钮长数据（见 callback.ts）
   * @param key 短键
   * @returns 动作；已过期时 undefined
   */
  loadCallback(key: string): Promise<ButtonAction | undefined>
}

/** 按钮回调的应答（`answerCallbackQuery` 的参数） */
export interface CallbackAnswer {
  /** 回调 id */
  callback_query_id: string
  /** 提示文字 */
  text?: string
  /** 是否以弹窗而非顶部提示显示 */
  show_alert?: boolean
}

/** 解码结果 */
export interface Decoded {
  /** 要投递的事件（可能为空：服务消息、认不出的消息） */
  events: IncomingEvent[]
  /** 按钮回调要回的应答 */
  answer?: CallbackAnswer
}

/** `answerCallbackQuery` 的提示文字上限 */
const MAX_ALERT = 200

/**
 * 是否群聊
 * @param chat 会话
 * @returns 是否 group / supergroup
 */
export function isGroupChat(chat: TgChat): boolean {
  return chat.type === "group" || chat.type === "supergroup"
}

/**
 * 会话 → 群信息
 * @param chat 会话
 * @returns 群信息
 */
export function toGroup(chat: TgChat): GroupInfo {
  const info: GroupInfo = { gid: toId(chat.id) }
  if (chat.title !== undefined) info.name = chat.title
  return info
}

/**
 * 群消息的发送者
 * @param msg 消息
 * @param ctx 平台查询
 * @returns 成员信息
 */
async function memberOf(msg: TgMessage, ctx: EventContext): Promise<MemberInfo> {
  const gid = toId(msg.chat.id)
  // 见文件头第二点：以会话身份发言（匿名管理员、关联频道）
  if (msg.sender_chat !== undefined) {
    return { ...chatAsUser(msg.sender_chat), gid, role: msg.sender_chat.id === msg.chat.id ? "admin" : "member" }
  }
  const from = msg.from ?? { id: msg.chat.id }
  return { ...toUser(from), gid, role: await ctx.roleOf(msg.chat.id, from.id) }
}

/**
 * 成员进出的服务消息 → 通知
 * @param msg 消息
 * @returns 通知；不是进出消息时空数组
 */
function memberNotices(msg: TgMessage): IncomingEvent[] {
  const gid = toId(msg.chat.id)
  const time = msg.date * 1000
  const operator = msg.from === undefined ? {} : { operatorId: toId(msg.from.id) }
  const out: IncomingEvent[] = []
  for (const user of msg.new_chat_members ?? []) {
    // 自己进群的人 from 就是自己；被拉进来的 from 是拉人的那位
    const invited = msg.from !== undefined && msg.from.id !== user.id
    out.push({ kind: "notice", noticeType: "group.increase", gid, uid: toId(user.id), ...operator, way: invited ? "invite" : "other", time, raw: msg })
  }
  const left = msg.left_chat_member
  if (left !== undefined) {
    const kicked = msg.from !== undefined && msg.from.id !== left.id
    out.push({ kind: "notice", noticeType: "group.decrease", gid, uid: toId(left.id), ...operator, way: kicked ? "kick" : "leave", time, raw: msg })
  }
  return out
}

/**
 * 解码一条新消息
 * @param msg 消息
 * @param ctx 平台查询
 * @returns 事件
 */
async function decodeNewMessage(msg: TgMessage, ctx: EventContext): Promise<IncomingEvent[]> {
  const group = isGroupChat(msg.chat)
  if (group && (msg.new_chat_members !== undefined || msg.left_chat_member !== undefined)) return memberNotices(msg)
  if (!group && msg.chat.type !== "private") return []

  const message = decodeMessage(msg, ctx)
  if (message.length === 0) return []
  const quote = decodeQuote(msg, ctx)
  const base = {
    kind: "message" as const,
    messageId: encodeMessageId(msg.chat.id, msg.message_id),
    seq: msg.message_id,
    message,
    time: msg.date * 1000,
    raw: msg,
    ...(quote === undefined ? {} : { quote })
  }
  if (group) {
    return [{ ...base, scene: "group", subType: "normal", group: toGroup(msg.chat), sender: await memberOf(msg, ctx) }]
  }
  const sender: UserInfo = msg.from === undefined ? chatAsUser(msg.chat) : toUser(msg.from)
  return [{ ...base, scene: "private", subType: "friend", sender }]
}

/**
 * 解码按钮回调
 * @param cb 回调
 * @param ctx 平台查询
 * @returns 事件与应答
 */
async function decodeCallbackQuery(cb: TgCallbackQuery, ctx: EventContext): Promise<Decoded> {
  const answer: CallbackAnswer = { callback_query_id: cb.id }
  const msg = cb.message
  // 内联模式的消息、或按钮所在消息已无法访问（date 为 0）：只应答，不投递
  if (msg === undefined || msg.date === 0 || cb.data === undefined || cb.data === "") return { events: [], answer }
  const action = await decodeCallback(cb.data, ctx.loadCallback)
  if (action === undefined) return { events: [], answer: { ...answer, text: "按钮已过期，请重新获取", show_alert: false } }
  if (action.kind === "prompt") {
    const text = `请发送：${action.text}`
    return { events: [], answer: { ...answer, text: text.length > MAX_ALERT ? `${text.slice(0, MAX_ALERT - 1)}…` : text, show_alert: true } }
  }

  const messageId = encodeMessageId(msg.chat.id, msg.message_id)
  const base = {
    kind: "message" as const,
    subType: "button",
    messageId,
    message: [{ type: "text" as const, text: action.text }],
    // 以"回复了按钮所在的那条消息"的形态投递：插件据此知道是哪张卡片上的按钮
    quote: { messageId },
    raw: cb
  }
  let event: IncomingMessageEvent
  if (isGroupChat(msg.chat)) {
    const sender: MemberInfo = { ...toUser(cb.from), gid: toId(msg.chat.id), role: await ctx.roleOf(msg.chat.id, cb.from.id) }
    event = { ...base, scene: "group", group: toGroup(msg.chat), sender }
  } else if (msg.chat.type === "private") {
    event = { ...base, scene: "private", sender: toUser(cb.from) }
  } else {
    return { events: [], answer }
  }
  return { events: [event], answer }
}

/**
 * 解码一个更新
 * @param update 更新
 * @param ctx 平台查询
 * @returns 事件与按钮应答
 */
export async function decodeUpdate(update: TgUpdate, ctx: EventContext): Promise<Decoded> {
  if (update.message !== undefined) return { events: await decodeNewMessage(update.message, ctx) }
  if (update.callback_query !== undefined) return decodeCallbackQuery(update.callback_query, ctx)
  return { events: [] }
}

/**
 * 从一个更新里取出"见过的人"（用于 `@用户名` 反查与发送时的 @ 展示名）
 * @param update 更新
 * @returns 用户列表
 */
export function usersOf(update: TgUpdate): TgUser[] {
  const out: TgUser[] = []
  const msg = update.message ?? update.callback_query?.message
  if (update.callback_query !== undefined) out.push(update.callback_query.from)
  if (msg?.from !== undefined) out.push(msg.from)
  if (msg?.reply_to_message?.from !== undefined) out.push(msg.reply_to_message.from)
  for (const e of [...(msg?.entities ?? []), ...(msg?.caption_entities ?? [])]) if (e.user !== undefined) out.push(e.user)
  for (const u of msg?.new_chat_members ?? []) out.push(u)
  return out
}

/**
 * 会话的展示名
 * @param chat 会话
 * @returns 群名或私聊对方的名字
 */
export function chatTitle(chat: TgChat): string {
  return chat.title ?? displayName(chat) ?? String(chat.id)
}
