# 交接说明：dsh-notify

这份文档写给**另一个对话**——`dsh-notify` 的初版是在那里做的（工作区
`C:\Users\Administrator\Documents\deepseek-harness\default-workspace`，
会话 `session-48cb01ac-8a5b-4712-bd63-e40933f1f469`）。

另一个会话（`session-c29e24fc-5564-4914-968f-a0291f3dd37e`）已经把这个插件**做完并
提交**，同时在真实环境里踩通了本地安装路径。这份文档说明**那边做了什么、哪些已经
验证过、哪些还没做**，避免重复劳动，也避免重踩同样的坑。

仓库位置：`C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-notify`
（已 `git init`，5 次提交，工作区干净）

---

## 一、当前状态一览

| 部分 | 状态 |
| --- | --- |
| 插件本体 | ✅ 完成（4 个模块 + 36 项测试 + 真机 toast 冒烟） |
| **真实宿主端到端** | ✅ **已验证**——`fiberPhase: active`，真实通知已弹出（见 `assets/screenshot-notification.png`） |
| 上架材料 | ✅ 齐备（`dsh.bundle` 声明、收录条目、`release:check` 全绿） |
| 文档 | ✅ README（含排查顺序）+ `release/HOW-TO-SUBMIT.md`（操作清单） |
| git | ✅ 已提交，工作区干净 |
| 上架（推 GitHub / 提 PR / 发 npm） | ❌ 未做，需要用户自己的账号，本机无凭据 |

**剩下的只有上架动作**（见 5.2）。

### 端到端确认的证据链

| 环节 | 证据 |
| --- | --- |
| 插件进入加载器树 | `list_plugins` → `include:dsh-notify`，`fiberPhase: "active"` |
| 宿主加载了模块 | 源文件 atime = 启动后约 3 秒 |
| `apply()` 注册了监听器 | 由「真实通知弹出」反证 |
| 传输层被调用 | 回合结束时刻出现 `powershell.exe` 进程 |
| 通知真的显示 | 用户在通知中心看到：标题=会话标题、正文=回复摘要 |

### 加载阶段踩过的两个坑（都会让插件完全不加载、且不报任何错）

这两个坑花了好几轮才定位，因为它们的表象和「触发逻辑写错」完全一样——什么都不发生：

1. **`cordis.patch.yml` 缩进里有 tab。** YAML 禁止 tab，整份文档解析失败，加载器**静默丢弃** `insert` 块，插件从未进入加载器树。诊断分水岭是 `list_plugins`：当时 `include:dsh-custom-instructions` 在、`include:dsh-notify` **不在**。
2. **声明了不需要的 `inject`。** 声明 injection 就是一次「等待」（Cordis hold 住插件直到该服务就绪），于是 `fiberPhase` 停在 `"pending"`。契约里可选依赖的正确形式是 `ctx.get(...)` + undefined 检查，**不声明 inject**。

**这两个坑现在都由 `scripts/release-check.mjs` 机械校验**，并做过反向验证（把 tab 或错误的 `config` 层级放回去，自检会失败）。

**最重要的教训（已写进 README 排查章节）**：先确认「加载了没有」，再怀疑逻辑。

```
list_plugins → include:dsh-notify → fiberPhase
   条目不存在 → cordis.patch.yml 没解析成功（tab / config 无子项）
   pending    → 在等服务（不该声明的 inject）
   active     → 插件在跑，这时才轮到看事件逻辑
```

当时的弯路：因为「没有通知」就一头扎进事件触发逻辑（还为此改了一版顺序无关的实现），而真正的故障在加载阶段。那版重构本身是对的、也保留了，但它**不是**症结所在。

---

## 二、那个会话已经完成的工作

### 2.1 仓库结构

行数是实测值，方便你判断改动规模：

```
dsh-notify/
├── lib/                                   共 1059 行
│   ├── index.js              397 行  事件接线（唯一面向宿主的模块）
│   ├── format.js             212 行  纯决策函数，无 I/O
│   ├── config.js              70 行  配置收敛（兜住手写进 profile 的非法值）
│   └── powershell-toast.js   380 行  WinRT toast 传输层
├── test/
│   ├── format.test.js                决策规则（17 项）
│   └── plugin.test.js                事件接线（16 项，注入假传输，不弹真通知）
├── scripts/
│   ├── set-bundle-state.mjs  ★ 本地安装/卸载（正确机制，见第四节）
│   ├── set-bundle-state.cmd    包装：自动找 DSH 自带的 node
│   ├── set-bundle-state.ps1    ⛔ 废弃（PS7 下写坏 JSON，已加硬拦截）
│   ├── install-local.ps1       ⛔ 废弃（同上）
│   ├── uninstall-local.ps1     ⛔ 废弃（同上）
│   ├── smoke-toast.mjs         真机冒烟：校验 Config + 真弹一条
│   ├── preview-toast.mjs       只弹一条，看真实排版
│   ├── repro-plugin-load.mjs   在不重启宿主的前提下复现「加载期抛错」
│   ├── verify-custom-instructions-fix.mjs  验证第六节那个上游 bug 的修复
│   ├── asar-grep.mjs           在打包的 asar 里搜源码（排查 DSH 内部错误用）
│   ├── capture-toast.py        抓通知截图（README/市场用）
│   ├── link-peers.mjs          把宿主的 schemastery 链进 node_modules，供测试
│   ├── prepare-release.mjs     填仓库坐标 + 生成收录条目
│   └── release-check.mjs       等价于市场 CI 的机械检查
├── assets/screenshot-1.png   真实通知截图
├── screenshots.json           声明截图（市场详情页展示）
├── cordis.patch.yml           bundle patch（installable 的关键）
├── package.json               已声明 dsh.bundle + repository 指向 ztl0001/dsh-notify
├── README.md / LICENSE / .gitignore / .gitattributes
└── release/
    ├── HOW-TO-SUBMIT.md                        上架操作清单
    └── awesome-dsh-plugin/ztl0001__dsh-notify.yml   收录条目
```

### 2.2 核心设计（这是插件的价值所在，别改掉）

DSH 里**「回合结束」不等于「任务完成」**。所以：

- `session/event` 的 `turn/end` **只记录结果**，不立刻通知
- 等 `agent/status` 变成 `idle`（再等 `settleDelayMs`，默认 400ms 确认没立刻继续）才发通知
- 于是**一条通知 = 一件真正做完的事**

**goal 目标模式**（一个目标会跑几十个回合）单独处理：

- 中间回合一律静默，只在目标 `complete` / `blocked` 时通知一次
- 例外：agent 停下来等人（提问／阻塞／报错）时立刻通知——它已经不自己往下跑了

配置项（`Config` schema，全部有中文描述）：`enabled` / `notifyOn`
(`every-turn` | `attention` | `never`) / `onlyMainSessions` / `settleDelayMs` /
`includeSummary` / `includeCwd` / `summaryLimit` / `sound` / `appId`。

### 2.3 已验证的内容

- **36 项测试全过**：`node --test "test/*.test.js"`。覆盖 goal 跑 5 轮只响 1 次、
  紧接着继续的回合不重复通知、用户自己取消不响、子代理静默、摘要读失败降级等。
  测试通过 `apply(ctx, config, transport)` 的**第三个参数注入假传输**，所以
  **不会真弹通知**。
- **真机 toast 冒烟通过**：`node scripts/smoke-toast.mjs` 校验 Config schema 后真弹一条。
- **真实截图**：`node scripts/preview-toast.mjs` + `scripts/capture-toast.py`，
  中文标题/emoji/多行正文显示正常。
- **30+ 次提交前自检**：`node scripts/release-check.mjs` 全绿。

---

## 三、开发中修掉的真实缺陷（每个都值得留着注释）

这些都是**只有真机才暴露**的，改动都带了原因注释，别当成冗余删掉：

### 3.1 PowerShell 侧

| 缺陷 | 现象 | 修法 |
| --- | --- | --- |
| `-Command -` 不从 stdin 读脚本 | 脚本第一行被当 cmdlet 名执行 | 改为落地成临时 `.ps1` 用 `-File` |
| **PS 5.1 里 `''` 被当空数组** | `$x -ne ''` 对空串返回 `True` → `Test-Path -LiteralPath ""` 抛错 → `$ErrorActionPreference='Stop'` 下**整条通知被吞** | 一律用 `[string]::IsNullOrEmpty()` |
| **stdin 走控制台代码页** | 中文标题在通知里**全是乱码**（实测踩到） | 传输层改成纯 ASCII：非 ASCII 编码为 `\uXXXX`，PS 侧解码 |
| stderr 是 GBK | 中文错误信息乱码 | 脚本内 `[Console]::OutputEncoding = UTF8` |
| 子进程 `unref()` | outcome 永不 resolve、干扰宿主事件循环 | 不 detach、不 unref，加 15s 守卫 |

### 3.2 Node/打包侧

- **`@deepseek-ai/*` 运行时包在 npm 上是 `access: restricted`**，所以**不能**把它们
  声明为非 optional 的 `peerDependencies`（会导致安装期 ERESOLVE）。当前只声明
  `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 且都标 `optional`。
- **schemastery 的校验是「抛错」不是「回退默认值」**：非法枚举值会让 Config 构造抛错。
  所以 `lib/config.js` 的 `normalize()` 是必要的一层，用来兜住手写进 profile 的非法值。
- `node --test test/` 在 Windows 上不可靠，要写 `node --test "test/*.test.js"`。

---

## 四、⚠️ 本地安装：三个坑（血泪，务必按这个来）

### 坑 1：新插件必须先成为 bundle

profile 的 `cordis.patch.yml` 是**按 id 覆盖已有条目**的层。往里面写
`- id: dsh-notify` 只会留下一个**指向不存在目标的 patch 行**——DSH 的启动是
all-or-nothing，**整个宿主起不来**。

正确做法：把包名加进 profile 的 `dsh.profile.bundles`，由加载器读该包自己的
`dsh.bundle.patch`（`cordis.patch.yml` 里的 `insert:` 行）插入条目。参考实现：
`dsh-custom-instructions`、`dsh-context` 都只出现在 bundles 里，不出现在 patch 里。

### 坑 2：运行中的宿主会回写 profile 配置

实测：写入 `package.json` 后 20 多秒被**内存状态覆盖回原样**（609 → 644 → 609 字节）。
先「看起来成功」，再静默失效。所以**必须先完全退出 DSH**。

### 坑 3：别用 PowerShell 改这些 JSON

早期版本用 PowerShell 写，在 Windows PowerShell **5.1** 上正常，在 **PowerShell 7**
上 `ConvertFrom-Json`/`ConvertTo-Json` 往返会产出**带尾随逗号的 JSON**，DSH 直接
拒绝启动：

```
Unexpected token ', {'   "name"... is not valid JSON
```

这个缺陷造成过一次真实的启动失败。现在这段逻辑由 `set-bundle-state.mjs` 用
**Node 的 JSON 实现**完成（一份实现、处处相同，写入前后各解析一次确认合法）。
三个有缺陷的 `.ps1` 都加了 PS 7 硬拦截，只作存档。

### 正确的安装方式（一条命令）

```sh
# 1) 完全退出 DSH（关窗口不算，托盘也要退）
# 2) 让插件作为 bundle 进入 profile
cd C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-notify
scripts\set-bundle-state.cmd --name @ztl0001/dsh-notify --action enable
# 3) 启动 DSH，随便跑一个任务；任务真正结束时会弹通知
```

撤销：同一条命令换成 `--action disable`。

脚本会自己检测 DSH 是否在跑并**拒绝执行**（别绕过它），写入前备份 `package.json`，
写入前后各做一次 JSON 合法性校验，并且会建好 `node_modules` 链接。

---

## 五、还没做的事

### 5.1 真实宿主端到端验证（最优先）

装上去之后要确认的重点，**不是「有没有弹」这么简单**：

1. 普通对话跑一个任务 → 任务结束时**弹一条**通知，内容含会话标题 + 状态 + 回复摘要
2. 如果开了 goal 目标模式 → 中间回合**不该响**，只在目标完成/阻塞时响一次
3. 通知里中文显示正常（编码这条链路已在真机验证过，但没经过宿主的完整路径）
4. 日志里应有 `dsh-notify:` 开头的记录

**已知的失败退路**：如果插件加载失败，**DSH 会整个起不来**（all-or-nothing）。所以
改完先确认能启动；起不来就退出 DSH 跑 `--action disable` 还原。

### 5.2 上架（需要用户账号，本机无凭据）

`release/HOW-TO-SUBMIT.md` 写了完整清单，摘要：

1. 在 GitHub 建 `ztl0001/dsh-notify`（空仓库），push，并加 `dsh-plugin` topic
2. 往 `awesome-dsh-plugin` 提 PR：**只加一个文件**
   `data/plugins/ztl0001__dsh-notify.yml`（内容就是 `release/awesome-dsh-plugin/` 下那份）
   - 注意：该仓库 CI 要求**仓库建满 1 天**，当天建的会被打回
   - **不要手改它的 README**（那两个 README 是从 `data/plugins/*.yml` 生成的）
3. 可选：发 npm（`npm publish --access public`）。必须先有 GitHub 仓库，
   否则 npm 包的 `repository` 无法关联。本机没有 npm CLI，需要 `corepack enable npm`

### 5.3 待确认的小事

- **GitHub 账号**：目前填的是 `ztl0001`（依据 `git config user.name` 和用户提供的信息）。
  若不是，重跑一次即可全部改写：
  `node scripts/prepare-release.mjs --owner <账号>`
- `assets/screenshot-1.png` 是在当时桌面背景下截的，投稿前可以换一张更干净的
  （`scripts/capture-toast.py` + 一张浅色桌面）。

---

## 六、顺手修掉的一个上游 bug（不在本仓库）

排查「DSH 起不来」时发现 `dsh-custom-instructions`（工作区里另一个项目）有个
**真实缺陷**，已修复：

`lib/index.js` 原来读 `ctx.config`。而在 Cordis 里 **`config` 不是服务**——它只是
`Symbol.for('cordis.config')`，所以 Context Proxy 会抛
`cannot get property "config" without inject`，导致 DSH all-or-nothing 启动失败。

修法：改用 `apply(ctx, config)` 的第二个参数（它就是实时配置对象——loader 用
cosmokit 的 `updateVolatile(target, source)` **原地更新**，所以闭包持有引用就能看到
新值，实时性没有牺牲）。

**源文件与 profile 副本都要改**（两者是独立副本，不是硬链接）。已在真实宿主验证：
插件出现在加载器里、状态 `schema`、DSH 正常启动。

---

## 七、给那个会话的建议

1. **先跑一遍自检**确认基线没被破坏：
   `node scripts/link-peers.mjs && node --test "test/*.test.js"`（应 36 项全过）
2. **优先做 5.1 的真实加载验证**——这是唯一还空着的一环，也是插件能不能算「完成」的关键
3. **改任何 profile 配置之前先完全退出 DSH**，用 `set-bundle-state.mjs`，不要手写 JSON、不要用 PowerShell
4. 上架那部分等 5.1 通过再做，因为市场 CI 会读你的仓库并要求「像描述说的那样工作」
5. 如果宿主起不来，用 `repro-plugin-load.mjs` 先在不重启的前提下复现加载错误
