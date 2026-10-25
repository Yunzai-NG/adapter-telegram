/**
 * 模块职责：账号配置校验与 id 编解码的单元测试
 * 依赖方向：测试文件，依赖 config.ts 与 platform.ts
 * 生命周期：无状态
 * 注意事项：无
 */
import { describe, expect, it } from "vitest"
import { SchemaError } from "@yunzai-ng/core"
import { DEFAULT_API_BASE, validateAccount } from "./config.js"
import { decodeMessageId, encodeMessageId, fromId, toId } from "./platform.js"

/**
 * 取校验失败的字段
 * @param input 输入
 * @returns 出错字段
 */
function issuesOf(input: unknown): string[] {
  try {
    validateAccount(input)
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaError)
    return (err as SchemaError).issues.map(i => i.path)
  }
  return []
}

describe("账号配置", () => {
  it("默认值齐全，只需填 token", () => {
    expect(validateAccount({ token: "123:abc-DEF_9" })).toMatchObject({
      token: "123:abc-DEF_9",
      proxy: "",
      apiBase: DEFAULT_API_BASE,
      photoMaxWidth: 1280,
      photoMaxHeight: 1280
    })
  })

  it("去掉 token 首尾空白、基址末尾的斜杠与误填的 /bot", () => {
    const a = validateAccount({ token: " 123:abc\n", apiBase: "https://tg.example.com/bot/" })
    expect(a.token).toBe("123:abc")
    expect(a.apiBase).toBe("https://tg.example.com")
  })

  it("token 形状、代理协议、基址各自报到对应字段", () => {
    expect(issuesOf({ token: "" })).toEqual(["token"])
    expect(issuesOf({ token: "abc" })).toEqual(["token"])
    expect(issuesOf({ token: "1:a", proxy: "socks5://127.0.0.1:1080" })).toEqual(["proxy"])
    expect(issuesOf({ token: "1:a", apiBase: "ftp://x" })).toEqual(["apiBase"])
    expect(issuesOf({ token: "1:a", apiBase: "https://u:p@x.com" })).toEqual(["apiBase"])
  })
})

describe("id", () => {
  it("toId 幂等、保留群 id 的负号；fromId 容忍未加前缀的值", () => {
    expect(toId(123)).toBe("tg_123")
    expect(toId("tg_123")).toBe("tg_123")
    expect(toId(-100123)).toBe("tg_-100123")
    expect(fromId("tg_-100123")).toBe("-100123")
    expect(fromId("123")).toBe("123")
  })

  it("消息 id 编进会话 id，按最后一个冒号切分", () => {
    expect(encodeMessageId(-100123, 45)).toBe("-100123:45")
    expect(decodeMessageId("-100123:45")).toEqual({ chatId: "-100123", messageId: 45 })
    expect(decodeMessageId("tg_-100123:45")).toEqual({ chatId: "-100123", messageId: 45 })
    expect(decodeMessageId("45")).toEqual({ messageId: 45 })
    expect(decodeMessageId("abc:45")).toBeUndefined()
    expect(decodeMessageId("1:0")).toBeUndefined()
    expect(decodeMessageId("uuid-like")).toBeUndefined()
  })
})
