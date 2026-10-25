/**
 * 模块职责：媒体工具的单元测试 —— 类型嗅探、图片尺寸、文件名补齐、multipart 拼装
 * 依赖方向：测试文件，依赖 media.ts
 * 生命周期：无状态
 * 注意事项：图片用手拼的最小文件头，不进仓库二进制样本
 */
import { describe, expect, it } from "vitest"
import { buildMultipart, describeFile, imageSize, loadMedia, sniffMime } from "./media.js"

/** 最小 PNG 头：签名 + IHDR 的宽高 */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

/** 最小 JPEG 头：SOI + 一个 APP0 段 + SOF0 */
function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0, 0, 0, 0])
}

describe("嗅探", () => {
  it("认得常见格式", () => {
    expect(sniffMime(png(1, 1))).toBe("image/png")
    expect(sniffMime(jpeg(1, 1))).toBe("image/jpeg")
    expect(sniffMime(Buffer.from("GIF89a......"))).toBe("image/gif")
    expect(sniffMime(Buffer.from("OggS\0\0\0\0"))).toBe("audio/ogg")
    expect(sniffMime(Buffer.from("#!AMR\n"))).toBe("audio/amr")
    expect(sniffMime(Buffer.from("hello"))).toBeUndefined()
  })

  it("读出 PNG / JPEG / GIF 的宽高；残缺的头给 undefined", () => {
    expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(imageSize(jpeg(800, 6000))).toEqual({ width: 800, height: 6000 })
    const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1")
    expect(imageSize(gif)).toEqual({ width: 320, height: 240 })
    expect(imageSize(png(1, 1).subarray(0, 12))).toBeUndefined()
  })

  it("文件名后缀以字节为准", () => {
    expect(describeFile(jpeg(1, 1), "image.png", "image/png", "image")).toMatchObject({ name: "image.jpg", mime: "image/jpeg" })
    expect(describeFile(Buffer.from("x"), undefined, undefined, "file")).toMatchObject({ name: "file", mime: "application/octet-stream" })
  })
})

describe("取媒体", () => {
  it("file_id 原样回传，不下载", async () => {
    const out = await loadMedia({ kind: "id", id: "AgAD" }, "image", undefined, () => Promise.reject(new Error("不该下载")))
    expect(out).toEqual({ kind: "id", id: "AgAD" })
  })

  it("外链经注入的下载函数取字节，带上请求头", async () => {
    let seen: Record<string, string> | undefined
    const out = await loadMedia({ kind: "url", url: "https://x/p/a.bin", headers: { Referer: "r" } }, "image", undefined, async (_url, headers) => {
      seen = headers
      return png(2, 2)
    })
    expect(seen).toEqual({ Referer: "r" })
    expect(out).toMatchObject({ kind: "file", file: { name: "a.png", mime: "image/png" } })
  })
})

describe("multipart", () => {
  it("文本字段在前、文件在后；对象按 JSON；空值跳过；文件名里的引号换掉", () => {
    const form = buildMultipart(
      { chat_id: -100, reply_markup: { inline_keyboard: [] }, caption: undefined },
      { photo: { data: Buffer.from("PNG"), name: 'a"b.png', mime: "image/png" } }
    )
    const text = Buffer.from(form.body).toString("utf8")
    const boundary = /boundary=(.+)$/.exec(form.contentType)![1]!
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true)
    expect(text).toContain('name="chat_id"\r\n\r\n-100\r\n')
    expect(text).toContain('name="reply_markup"\r\n\r\n{"inline_keyboard":[]}\r\n')
    expect(text).not.toContain("caption")
    expect(text).toContain('name="photo"; filename="a_b.png"\r\nContent-Type: image/png\r\n\r\nPNG\r\n')
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true)
  })
})
