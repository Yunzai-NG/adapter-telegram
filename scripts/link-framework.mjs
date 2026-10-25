#!/usr/bin/env node
/**
 * 将框架包链接进本仓库的 node_modules —— 框架发布到 npm 之前的构建前提
 *
 * 为什么需要这一步：`@yunzai-ng/core` 与 `@yunzai-ng/types` 声明为
 * peerDependencies（运行期由宿主提供，见 .npmrc 的说明），而 `.npmrc` 中
 * `auto-install-peers=false`，因此 `pnpm install` 不会安装它们。框架尚未发布时
 * 亦无从安装。缺少这两个包时 `tsc -b` 报 `Cannot find module "@yunzai-ng/core"`。
 *
 * 该脚本在 node_modules/@yunzai-ng/ 下建立指向框架 checkout 的链接，做法与内核
 * 把框架包链接进使用者主目录（packages/cli/src/link.ts）完全一致。
 *
 * 框架位置的查找顺序：`YZNG_FRAMEWORK` 环境变量 → `../yunzai-ng`、`../../yunzai-ng`
 * （框架与插件仓库平级或同祖时）→ `../../code`。找不到时报错并提示设置环境变量。
 *
 * Windows 上使用 junction 而非 symlink：目录 symlink 需要开发者模式或管理员权限，
 * junction 无此要求，而对 Node 与 tsc 的解析行为两者等价。
 *
 * 用法：node scripts/link-framework.mjs
 */
import { existsSync } from "node:fs"
import { lstat, mkdir, rm, symlink } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

/** 仓库根 */
const ROOT = path.resolve(import.meta.dirname, "..")

/** 需要链接的框架包，键为包名，值为其在框架仓库中的相对路径 */
const PACKAGES = {
  "@yunzai-ng/core": "packages/core",
  "@yunzai-ng/types": "packages/types",
  "@yunzai-ng/jsx": "packages/jsx"
}

/** 判定一个目录是否为框架仓库根：三个包目录齐备即认定 */
function isFrameworkRoot(dir) {
  return Object.values(PACKAGES).every(rel => existsSync(path.join(dir, rel, "package.json")))
}

/** 按优先级定位框架仓库 */
function findFramework() {
  const candidates = []
  if (process.env.YZNG_FRAMEWORK) candidates.push(path.resolve(process.env.YZNG_FRAMEWORK))
  candidates.push(
    path.resolve(ROOT, "..", "yunzai-ng"),
    path.resolve(ROOT, "..", "..", "yunzai-ng"),
    path.resolve(ROOT, "..", "..", "code")
  )
  for (const dir of candidates) {
    if (isFrameworkRoot(dir)) return dir
  }
  return undefined
}

const framework = findFramework()
if (framework === undefined) {
  console.error("未找到框架仓库。请设置 YZNG_FRAMEWORK 指向 yunzai-ng 的 checkout 根目录，")
  console.error("或将其置于 ../yunzai-ng、../../yunzai-ng、../../code 之一。")
  process.exit(1)
}

const scopeDir = path.join(ROOT, "node_modules", "@yunzai-ng")
await mkdir(scopeDir, { recursive: true })

let linked = 0
for (const [name, rel] of Object.entries(PACKAGES)) {
  const target = path.join(framework, rel)
  const link = path.join(scopeDir, name.slice("@yunzai-ng/".length))

  // 已存在的真实目录一律不动：那是 pnpm install 装下的正式版本，
  // 覆盖它会让"装了发布版"与"链了本地源码"两种状态无法区分
  if (existsSync(link)) {
    const stat = await lstat(link)
    if (!stat.isSymbolicLink()) {
      console.error(`跳过 ${name}：${link} 是真实目录，疑为 pnpm install 的产物`)
      continue
    }
    await rm(link, { recursive: true, force: true })
  }
  await symlink(target, link, "junction")
  linked += 1
}

console.error(`已链接 ${linked} 个框架包 → ${framework}`)

// tsc 读的是框架的 dist/*.d.ts，框架未构建时链接建立了也编译不过。
// 此处先行给出可理解的提示，而非留给 tsc 报一条指向 node_modules 的错
const missing = Object.entries(PACKAGES)
  .filter(([, rel]) => !existsSync(path.join(framework, rel, "dist", "index.d.ts")))
  .map(([name]) => name)
if (missing.length > 0) {
  console.error(`注意：${missing.join("、")} 尚未构建，请先在框架仓库执行 pnpm run build`)
}
