/**
 * 模块职责：内联按钮 `callback_data` 的编解码
 * 依赖方向：依赖 node:crypto；不依赖内核
 * 生命周期：纯函数（长数据的存取经注入的函数完成）
 * 注意事项：**`callback_data` 最长 64 字节。** 而按钮要带回的往往是一条完整指令（`#原神绑定 1234…`），
 *          中文一个字就占 3 字节。短的直接内联，长的存进 KV、按钮上只放一个短键：
 *
 *          - `=s<文本>`：点击后把文本当作用户发言投递（`callback`，或 `input` 且 `enter`）
 *          - `=p<文本>`：点击后提示用户手动发送这段文本（`input` 且不 `enter`）
 *          - `#<16 位十六进制>`：KV 里的 `{ kind, text }`
 *
 *          短键取内容的哈希而不是随机数：同一张帮助卡片发一百次只占一条 KV。
 *          不认得前缀的数据（别的程序发的按钮）整段当作 `send` 文本，与 adapter-kook 处理
 *          外来按钮 value 的方式一致。
 */
import { createHash } from "node:crypto"

/** callback_data 的字节上限 */
export const CALLBACK_DATA_MAX = 64

/** 按钮点击后的动作 */
export interface ButtonAction {
  /** send：当作用户发言；prompt：提示用户手动发送 */
  kind: "send" | "prompt"
  /** 文本 */
  text: string
}

/**
 * 编码按钮动作
 * @param action 动作
 * @param store 存长数据的函数（键 → 动作）
 * @returns callback_data
 */
export async function encodeCallback(
  action: ButtonAction,
  store: (key: string, action: ButtonAction) => Promise<void>
): Promise<string> {
  const inline = `=${action.kind === "send" ? "s" : "p"}${action.text}`
  if (Buffer.byteLength(inline, "utf8") <= CALLBACK_DATA_MAX) return inline
  const key = createHash("sha256").update(`${action.kind}\n${action.text}`).digest("hex").slice(0, 16)
  await store(key, action)
  return `#${key}`
}

/**
 * 解码按钮动作
 * @param data callback_data
 * @param load 取长数据的函数
 * @returns 动作；短键在 KV 里已过期时 undefined
 */
export async function decodeCallback(
  data: string,
  load: (key: string) => Promise<ButtonAction | undefined>
): Promise<ButtonAction | undefined> {
  if (data.startsWith("=s")) return { kind: "send", text: data.slice(2) }
  if (data.startsWith("=p")) return { kind: "prompt", text: data.slice(2) }
  if (/^#[0-9a-f]{16}$/.test(data)) return load(data.slice(1))
  return { kind: "send", text: data }
}
