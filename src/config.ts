/**
 * 模块职责：账号配置的 schema、类型与校验
 * 依赖方向：仅依赖内核的 schema 工具与类型包
 * 生命周期：模块加载期构造一次 schema，之后只读
 * 注意事项：**该 schema 即为面板中的"添加账号"表单**，`title` / `desc` 是最终用户所见文案。
 *
 *          一个账号记录一个 token，增删、启停、重连都由内核的账号管理统一做；代理与 API 基址
 *          也是每个账号各自的字段，不设全局项。
 */
import { s, SchemaError } from "@yunzai-ng/core"
import type { Infer, SchemaIssue } from "@yunzai-ng/core"

/** Bot API 的缺省基址 */
export const DEFAULT_API_BASE = "https://api.telegram.org"

/** token 的形状：`<机器人数字 id>:<35 位左右的密钥>` */
const TOKEN_RE = /^\d+:[\w-]+$/

/** 账号配置 schema */
export const ACCOUNT_SCHEMA = s.object({
  token: s
    .password()
    .default("")
    .title("Bot Token")
    .desc("在 Telegram 里找 @BotFather：/newbot 创建机器人，或 /mybots → API Token 取得")
    .placeholder("123456789:AAH...")
    .order(1),

  proxy: s
    .string()
    .default("")
    .title("代理")
    .desc(
      "国内网络直连不上 api.telegram.org，一般需要填。支持 http:// 与 https:// 代理，形如 http://127.0.0.1:7890。" +
        "留空则沿用全局代理设置（框架配置 net.proxy 或环境变量 HTTPS_PROXY）"
    )
    .placeholder("http://127.0.0.1:7890")
    .group("连接")
    .order(10),

  apiBase: s
    .string()
    .default(DEFAULT_API_BASE)
    .title("API 基址")
    .desc("一般不用改。经反向代理访问、或使用自建的 Bot API 服务器时填其地址（不含 /bot<token>）")
    .group("连接")
    .order(11),

  timeout: s
    .duration()
    .default("60s")
    .title("接口调用超时")
    .desc("单次 API 调用（发消息、上传文件）等待多久判定为失败。长轮询本身另有固定的等待时长，不受此项影响")
    .group("连接")
    .order(12),

  photoMaxWidth: s
    .number()
    .int()
    .min(1)
    .default(1280)
    .title("图片最大宽度")
    .desc("宽或高超过上限的图片改以文件发送：Telegram 会把图片压缩到 1280 像素左右，长截图会糊成一片")
    .group("发送")
    .order(20),

  photoMaxHeight: s
    .number()
    .int()
    .min(1)
    .default(1280)
    .title("图片最大高度")
    .desc("同上")
    .group("发送")
    .order(21),

  adminCacheTtl: s
    .duration()
    .default("10m")
    .title("群管理员列表缓存有效期")
    .desc(
      "判断「群管理员」要用到管理员列表，每条消息都查一次会撞上频率限制，故缓存这么久。" +
        "代价是任免管理员后要等这么久才生效"
    )
    .group("缓存")
    .order(30)
})

/** 账号配置，由 schema 推导而来 */
export type TelegramAccount = Infer<typeof ACCOUNT_SCHEMA>

/**
 * 校验一个地址是否为 http(s)
 * @param value 地址
 * @returns 出错原因；合法时 undefined
 */
function checkHttpUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `${value} 不是合法地址`
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `只支持 http:// 与 https://，当前为 ${url.protocol}//`
  return undefined
}

/**
 * 校验并规范化账号配置
 *
 * schema 只管单字段类型；token 的形状、两个地址的协议在这里补查。
 * @param input 面板提交的原始对象
 * @returns 规范化后的配置
 * @throws SchemaError 校验不通过；`issues[].path` 与表单字段名对应
 */
export function validateAccount(input: unknown): TelegramAccount {
  const account = ACCOUNT_SCHEMA.parse(input)
  const issues: SchemaIssue[] = []

  // 从 BotFather 复制时常带上首尾空白或换行
  const token = account.token.trim()
  if (token === "") {
    issues.push({ path: "token", message: "不能为空：在 Telegram 里找 @BotFather 取得", severity: "error" })
  } else if (!TOKEN_RE.test(token)) {
    issues.push({ path: "token", message: "格式不对，应形如 123456789:AAH…（数字、冒号、一串字母数字）", severity: "error" })
  }

  const proxy = account.proxy.trim()
  if (proxy !== "") {
    const why = checkHttpUrl(proxy)
    if (why !== undefined) issues.push({ path: "proxy", message: `${why}。SOCKS 代理请在本机转成 HTTP 代理再填`, severity: "error" })
  }

  // 末尾的斜杠与误填进来的 `/bot` 都剥掉：拼地址时由客户端补 `/bot<token>/`
  const apiBase = account.apiBase.trim().replace(/\/+$/, "").replace(/\/bot$/i, "")
  const why = checkHttpUrl(apiBase)
  if (why !== undefined) {
    issues.push({ path: "apiBase", message: `${why}，应形如 ${DEFAULT_API_BASE}`, severity: "error" })
  } else {
    const url = new URL(apiBase)
    if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
      issues.push({ path: "apiBase", message: "不能带查询串、锚点或用户名密码", severity: "error" })
    }
  }

  if (issues.length > 0) throw new SchemaError(issues)

  return { ...account, token, proxy, apiBase }
}
