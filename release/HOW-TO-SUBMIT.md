# 上架操作清单

这个目录里已经准备好了上架需要的东西，但**最后几步必须用你自己的账号**（本机没有任何 GitHub / npm 凭据），所以下面是要你亲手执行的部分。

已经做完的：

- `package.json` 已声明 `dsh.bundle` 并指向 `./cordis.patch.yml`——这是能被 `dsh plugin add` 安装的前提，也是投稿最常见的被拒原因（只声明 `dsh.client` 不行）
- `package.json` 的 `repository` / `homepage` / `bugs` 已指向 `https://github.com/ztl0001/dsh-notify`
- 收录条目已生成：`release/awesome-dsh-plugin/ztl0001__dsh-notify.yml`
- `screenshots.json` + `assets/screenshot-1.png`：市场详情页会展示的真实通知截图
- `npm run release:check` 全部通过（等价于市场 CI 的机械检查）

---

## 一、建仓库并推送

```sh
cd dsh-notify
git remote add origin https://github.com/ztl0001/dsh-notify
git push -u origin main
```

仓库要**先在 GitHub 上建好**（空的就行，不要勾 README/gitignore）。

然后给仓库加上 `dsh-plugin` topic（仓库页右上 About → 齿轮 → Topics）。这是收录的硬性要求之一。

## 二、投稿到插件市场

市场（Settings → 插件市场）的列表来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 这个仓库。**收录 = 往它提一个 PR，只新增一个文件**。

### 实测可行的做法：命令行 + 一个链接（推荐）

网页那套**在这个环境里真的走不通**：Fork 按钮点了没反应；而且从上游仓库点 New file 会落到
上游，于是报「There isn't anything to compare」。下面这套是**实际跑通过**的——
dsh-notify 的 PR #7482 就是这么提交的：

```sh
# 1. 把上游克隆到临时目录
git clone --depth 1 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git /tmp/pr
cd /tmp/pr

# 2. 建分支，把条目文件放进去（文件名见下）
git checkout -b add-dsh-notify
mkdir -p data/plugins
cp <本仓库路径>/release/awesome-dsh-plugin/ztl0001__dsh-notify.yml data/plugins/
git add data/plugins/ztl0001__dsh-notify.yml
git commit -m "Add dsh-notify"

# 3. 推到你的 fork（GitHub 会给出去创建 PR 的链接）
git remote add fork https://github.com/ztl0001/awesome-dsh-plugin.git
git push -u fork add-dsh-notify
```

最后一步只能在网页上完成，用这个链接（`git push` 的输出里 GitHub 自己也会打印它）：

```
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...ztl0001:add-dsh-notify?expand=1
```

打开后点两次绿色按钮即可。

> ⚠️ **`?expand=1` 不能省。** 少了它会落到上游仓库的对比页，显示
> 「There isn't anything to compare」——因为分支在你的 fork 里，上游看不到。

### 如果一定要走纯网页

只有一条路是稳的：**直接打开 fork 专用页**

```
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/fork
```

（比在仓库页里找按钮稳）。fork 成功后再**在你自己 fork 的仓库页面**点
`Add file` → `Create new file`，路径填 `data/plugins/ztl0001__dsh-notify.yml`。

### 要点

- **不要手改它的 README**，那两个 README 是从 `data/plugins/*.yml` 生成的
- 一个 PR 最多加 3 条
- 仓库必须**建满 1 天**，CI 会自动检查。今天建的会被打回——**这是唯一「时间自愈」的失败**：
  仓库里的 `regate.yml` 每 6 小时自动重跑一次检查，到点就绿。**不要**重开 PR、不要 push、
  不要关闭重开（它的报错原文就是这么说的）
- CI 会重新拉取你仓库的 `package.json` 检查 `dsh.bundle`，并重新生成 README
- 描述里若有 **`冒号+空格`**，YAML 必须加引号（`en: 'Foo: bar.'`），否则整个文件解析失败。
  `prepare-release.mjs` 现在会强制过一遍解析器，不允许写出坏文件

## 三、发布到 npm（可选，但推荐）

发了 npm 之后市场会显示下载量、并且安装时跳过源码构建授权。**收录本身不依赖它**。

发布有几个前提，请留意：

- 需要一个 npm 账号，并且 `@` 作用域不需要——这个包名 `dsh-notify` 是无作用域的，直接 `npm publish` 即可
- 本机**没有安装 npm CLI**（只有 Node 和 pnpm）。装一个再发布：

  ```sh
  # 用 Node 自带的 corepack 启用 npm，或到 nodejs.org 下载安装
  corepack enable npm
  npm login
  cd dsh-notify
  npm publish --access public
  ```

- 发布**必须在仓库已存在之后**做：npm 包的 `repository` 字段要能指回真实仓库，否则市场不会把这个包和你的仓库关联起来
- `prepack` 会自动跑 `release:check`，不通过就发不出去

## 四、做完之后确认

```sh
cd dsh-notify
npm run release:check     # 机械检查
npm test                  # 36 项
```

然后等一天再提 PR（仓库年龄门槛）。

---

## 想知道能不能用，先本地装

在投稿之前不用等市场，本地就能装：

```sh
dsh plugin --profile desktop add <仓库地址或本地路径>
```

或者用本仓库自带的手装脚本：

```sh
# 1) 完全退出 DSH（关窗口不算，要退出应用）
# 2) 把这个包作为 bundle 加进 profile
node scripts/set-bundle-state.mjs --name @ztl0001/dsh-notify --action enable
# Windows 上没有 node 在 PATH 时：scripts\set-bundle-state.cmd --name @ztl0001/dsh-notify --action enable
# 3) 启动 DSH，随便跑一个任务；任务真正结束时会弹通知
```

**装完必须重启 DSH**：bundle/patch 层只在启动时合成，不会热生效。

> ⚠️ 三个踩过的坑，别再踩一次：
>
> 1. **别用「往 profile 的 `cordis.patch.yml` 里加一行 `- id: dsh-notify`」这种写法。**
>    patch 层只能*按 id 覆盖已有条目*，插件还没加载时那一行没有目标，DSH 启动直接
>    失败（all-or-nothing，整个宿主起不来）。新插件必须先作为 bundle 出现在
>    profile 的 `dsh.profile.bundles` 里。
> 2. **改 profile 配置前必须完全退出 DSH。** 运行中的宿主会用内存状态回写
>    `package.json`——实测写入后 20 多秒被覆盖回原样，先「看起来成功」再静默失效。
>    `set-bundle-state.mjs` 会先检测并拒绝，别绕过它。
> 3. **别用 PowerShell 改这些 JSON。** 早期版本用 PowerShell 写，在 Windows
>    PowerShell 5.1 上没问题，在 PowerShell 7 上 `ConvertFrom-Json`/`ConvertTo-Json`
>    往返会产出带尾随逗号的 JSON，DSH 直接拒绝启动（`Unexpected token ', {'`）。
>    `scripts/*.ps1` 里那几个只是存档，**不要再用**。

撤销：

```sh
node scripts/set-bundle-state.mjs --name @ztl0001/dsh-notify --action disable
```
