/**
 * 模块职责：发送侧的媒体处理 —— 读取字节、嗅探类型与图片尺寸、拼 multipart 请求体
 * 依赖方向：依赖 node:fs / node:path 与类型包；不依赖内核
 * 生命周期：纯函数
 * 注意事项：**外链也由本机下载再上传，不交给 Telegram 去拉。** Bot API 允许直接传 http 地址，
 *          但 Telegram 服务器带不上 `MediaRef.headers`（米游社图床的防盗链），拉取失败时只回一句
 *          "wrong file identifier/HTTP URL specified"，也不支持 20MB 以上的文件。本机下载虽多一跳，
 *          行为却与 path / buffer 一致。
 *
 *          `kind: "id"` 是 Telegram 的 file_id（接收侧产出的就是它），原样回传、零传输。
 *
 *          **图片尺寸自己解析。** 这里只需要宽高，五种常见格式的文件头各几行就能读出来，
 *          不值得为它引一个依赖。
 */
import { readFile } from "node:fs/promises"
import { basename, extname } from "node:path"
import type { MediaRef } from "@yunzai-ng/types"

/** 扩展名 → MIME（只列常见的几类） */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".amr": "audio/amr",
  ".txt": "text/plain",
  ".json": "application/json",
  ".zip": "application/zip",
  ".pdf": "application/pdf"
}

/** MIME → 扩展名（`MIME_BY_EXT` 的反查，取第一个） */
const EXT_BY_MIME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MIME_BY_EXT)
    .reverse()
    .map(([ext, mime]) => [mime, ext])
)

/**
 * 从文件头嗅探 MIME
 *
 * 渲染器出的图、插件 `readFile` 读进来的图都只有字节、没有文件名，而发图还是发文件、
 * 发语音还是发音乐都要据此判断。
 * @param b 字节
 * @returns MIME；认不出时 undefined
 */
export function sniffMime(b: Uint8Array): string | undefined {
  const ascii = (from: number, to: number): string => String.fromCharCode(...b.subarray(from, to))
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b.length >= 6 && ascii(0, 4) === "GIF8") return "image/gif"
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp"
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav"
  if (b.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12)
    if (brand.startsWith("M4A")) return "audio/mp4"
    if (brand === "qt  ") return "video/quicktime"
    return "video/mp4"
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm"
  if (b.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg"
  if (b.length >= 4 && ascii(0, 4) === "fLaC") return "audio/flac"
  if (b.length >= 6 && ascii(0, 6) === "#!AMR\n") return "audio/amr"
  if (b.length >= 3 && ascii(0, 3) === "ID3") return "audio/mpeg"
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return "audio/mpeg"
  if (b.length >= 4 && ascii(0, 4) === "%PDF") return "application/pdf"
  return undefined
}

/**
 * 由文件名猜 MIME
 * @param name 文件名或路径
 * @returns MIME；认不出时 undefined
 */
export function mimeOfName(name: string): string | undefined {
  return MIME_BY_EXT[extname(name).toLowerCase()]
}

/** 图片宽高 */
export interface ImageSize {
  /** 宽 */
  width: number
  /** 高 */
  height: number
}

/**
 * 读 JPEG 的宽高：逐段跳过，直到遇到 SOFn
 * @param b 字节
 * @returns 宽高；读不出时 undefined
 */
function jpegSize(b: Uint8Array): ImageSize | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined
    const marker = b[i + 1]!
    // 填充字节
    if (marker === 0xff) {
      i++
      continue
    }
    // 无长度的标记
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2
      continue
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) }
    i += 2 + view.getUint16(i + 2)
  }
  return undefined
}

/**
 * 从文件头读图片宽高
 * @param b 字节
 * @returns 宽高；不是认得的图片格式或文件头残缺时 undefined
 */
export function imageSize(b: Uint8Array): ImageSize | undefined {
  const mime = sniffMime(b)
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  try {
    switch (mime) {
      case "image/png":
        return b.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : undefined
      case "image/gif":
        return b.length >= 10 ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : undefined
      case "image/bmp":
        return b.length >= 26 ? { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) } : undefined
      case "image/jpeg":
        return jpegSize(b)
      case "image/webp": {
        const chunk = String.fromCharCode(...b.subarray(12, 16))
        if (chunk === "VP8 " && b.length >= 30) {
          return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
        }
        if (chunk === "VP8L" && b.length >= 25) {
          const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!]
          return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
        }
        if (chunk === "VP8X" && b.length >= 30) {
          const u24 = (at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
          return { width: 1 + u24(24), height: 1 + u24(27) }
        }
        return undefined
      }
      default:
        return undefined
    }
  } catch {
    // DataView 越界：文件头残缺
    return undefined
  }
}

/** 一份待上传的文件 */
export interface UploadFile {
  /** 字节 */
  data: Uint8Array
  /** 文件名（带正确后缀） */
  name: string
  /** MIME */
  mime: string
}

/**
 * 补齐文件名与 MIME
 *
 * 优先级：字节嗅探 > 调用方声明 > 文件名后缀 > 兜底。嗅探排第一，因为声明的 mime 与后缀
 * 都可能是错的（渲染器缺省 `image.png`，实际是 jpeg）—— 而字节不会说谎。
 * @param data 字节
 * @param name 候选文件名
 * @param mime 调用方声明的 MIME
 * @param fallback 兜底文件名主干，如 `image`
 * @returns 待上传文件
 */
export function describeFile(data: Uint8Array, name: string | undefined, mime: string | undefined, fallback: string): UploadFile {
  const type = sniffMime(data) ?? mime ?? (name === undefined ? undefined : mimeOfName(name)) ?? "application/octet-stream"
  const base = name === undefined || name === "" ? fallback : basename(name)
  const wantExt = EXT_BY_MIME[type]
  // 后缀已与类型相符（含 .jpg / .jpeg 这类一对多）就不动；否则换成类型对应的后缀
  if (mimeOfName(base) === type || wantExt === undefined) return { data, name: base, mime: type }
  return { data, name: `${base.slice(0, base.length - extname(base).length)}${wantExt}`, mime: type }
}

/** 解析后的媒体：要么是 Telegram 侧已有的 file_id，要么是本机拿到的字节 */
export type LoadedMedia = { kind: "id"; id: string } | { kind: "file"; file: UploadFile }

/**
 * 取得媒体内容
 * @param ref 媒体引用
 * @param fallback 兜底文件名主干
 * @param name 调用方指定的文件名
 * @param download 下载远端地址的函数（走 `ctx.http`）
 * @returns file_id 或字节
 */
export async function loadMedia(
  ref: MediaRef,
  fallback: string,
  name: string | undefined,
  download: (url: string, headers?: Record<string, string>) => Promise<Uint8Array>
): Promise<LoadedMedia> {
  switch (ref.kind) {
    case "id":
      return { kind: "id", id: ref.id }
    case "url": {
      const data = await download(ref.url, ref.headers)
      const urlName = basename(new URL(ref.url).pathname)
      return { kind: "file", file: describeFile(data, name ?? (urlName || undefined), undefined, fallback) }
    }
    case "path": {
      let data: Uint8Array
      try {
        data = await readFile(ref.path)
      } catch (err) {
        throw new Error(`读取 ${ref.path} 失败：${err instanceof Error ? err.message : String(err)}`)
      }
      return { kind: "file", file: describeFile(data, name ?? ref.path, undefined, fallback) }
    }
    case "buffer":
      return { kind: "file", file: describeFile(ref.data, name ?? ref.name, ref.mime, fallback) }
    case "base64": {
      const raw = ref.base64.replace(/^base64:\/\//, "").replace(/^data:[^;,]*;base64,/, "")
      return { kind: "file", file: describeFile(Buffer.from(raw, "base64"), name, ref.mime, fallback) }
    }
  }
}

/** 一段 multipart/form-data 请求体 */
export interface Multipart {
  /** 请求体字节 */
  body: Uint8Array
  /** 带 boundary 的 Content-Type 头 */
  contentType: string
}

/**
 * 构造 multipart/form-data 请求体：若干文本字段 + 若干文件字段
 *
 * 手工拼而不是用 `FormData`：内核的 HTTP 客户端只收 `string | Uint8Array` 请求体。
 * 对象值按 JSON 序列化 —— Bot API 的 `reply_markup`、`reply_parameters` 在 multipart 里
 * 就是这样传的。
 * @param fields 文本字段；undefined / null 的键跳过
 * @param files 文件字段
 * @returns 请求体与 Content-Type
 */
export function buildMultipart(fields: Record<string, unknown>, files: Record<string, UploadFile>): Multipart {
  const boundary = `----yunzai-ng-tg-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  const parts: Buffer[] = []
  // 引号与换行会破坏 Content-Disposition 头；字段名由本适配器给出，文件名替换掉无损
  const safe = (text: string): string => text.replace(/["\r\n\\]/g, "_")
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    const text = typeof value === "object" ? JSON.stringify(value) : String(value)
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(key)}"\r\n\r\n${text}\r\n`, "utf8"))
  }
  for (const [key, file] of Object.entries(files)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${safe(key)}"; filename="${safe(file.name)}"\r\n` +
          `Content-Type: ${file.mime}\r\n\r\n`,
        "utf8"
      ),
      Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength),
      Buffer.from("\r\n", "utf8")
    )
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}
