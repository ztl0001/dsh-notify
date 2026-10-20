# dsh-notify

<https://github.com/ztl0001/dsh-notify>

DSH 任务完成时，在 Windows 通知栏弹一条原生通知。

你可以把 DSH 窗口最小化去干别的，不用一直盯着它——任务真的做完了，通知会告诉你。通知里带上**会话标题**、**结果状态**和**最后一条回复的摘要**：

> ✅ 给 DSH 加一个任务完成通知插件
> 已实现 Windows 原生通知：监听 turn/end 与 agent/status，在 agent 真正空闲时弹出通知……

## 它和其他「回合结束就响」的做法有什么不同

DSH 里「一个回合结束」不等于「任务做完了」。开着 **goal 目标模式**时，一个目标会跑几十个回合；中间每个回合结束都弹一条通知，只会让人把通知关掉。

这个插件把两个信号合起来判断：

| 信号 | 说明 | 单独用的问题 |
| --- | --- | --- |
| `session/event` 的 `turn/end` | 带结束原因（完成／出错／被取消……） | 目标是多回合的，每回合都通知太吵 |
| `agent/status` 的 `idle` | 真正没有任何驱动在跑 | 不知道是怎么结束的 |

**做法**：回合结束时只*记录*结果，等 agent 进入 `idle`（再等一小段时间确认没有立刻继续）才发通知。于是**一条通知 = 一件真正做完的事**。

挂了 goal 目标时更严格：中间回合一律安静，只在**目标完成或阻塞**时通知一次。唯一的例外是 agent 停下来在等人（提问／阻塞／报错）——这时候它已经不自己往下跑了，值得打断你。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-notify-toast
```

在插件市场（Settings → 插件市场）里搜 `dsh-notify` 也能一键安装。

安装后在 **Settings → 插件** 里可以改配置，也可以直接写进 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-notify
  name: 'dsh-notify-toast'
  config:
    notifyOn: every-turn
    onlyMainSessions: true
    settleDelayMs: 400
    includeSummary: true
    includeCwd: false
    summaryLimit: 220
    sound: kind
```

## 配置项

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后插件照常加载，但一条通知都不发。 |
| `notifyOn` | `every-turn` | `every-turn`：每个回合结束通知一次，但挂了目标的会话只在整个目标结束时通知；`attention`：只在 agent 停下来等人时通知；`never`：从不通知。 |
| `onlyMainSessions` | `true` | 不通知子代理（subagent）会话。 |
| `settleDelayMs` | `400` | agent 进入空闲后再等这么久（毫秒）才发，用来把紧接着继续的几个回合合并成一条。 |
| `includeSummary` | `true` | 带上会话标题和最后一条回复的摘要。 |
| `includeCwd` | `false` | 附带工作目录，便于区分同时跑的多个会话。 |
| `summaryLimit` | `220` | 正文最大字符数。 |
| `sound` | `kind` | `kind`：按结果自动选（完成用 `Default`，出错用 `Reminder`）；`silent`：静音；也可以填具体的 WinRT 提示音名（`Reminder`／`IM`／`Mail`／`SMS`／`Alarm`…）。 |
| `appId` | 空 | 可选的 AppUserModelID（例如某个应用快捷方式的 AUMID）。留空时按 `DSH_APP_USER_MODEL_ID` 环境变量 → Windows PowerShell 的顺序回退。 |
| `debug` | `false` | 把每一次决策写进宿主日志（收到哪个回合结束、为什么没通知）。排查「该弹没弹」时打开它。 |

### 触发点为什么是 `turn/end` 而不是 `idle`

第一版把延迟调度放在 `agent/status → idle` 上，并要求 `turn/end` 已经先到。这在真实宿主里静默失效了：宿主**先报 idle、后提交 turn end**，于是 idle 那一刻还没有待发内容，通知永远不会被安排——没有报错，也没有任何东西可看。

现在**调度只发生在 `turn/end`**（它才是定义结果的那个事件），`idle` 只做过滤：

- `turn/end` → 记录结果 + 安排延迟通知
- `running` → 取消待发通知（新的工作取代了它，任务还在跑就不能报「已完成」）
- 延迟窗口内又来了 `turn/end` → 重新计时（把连续回合合并成一条）

这样**两个事件的先后顺序不再影响正确性**，`test/plugin.test.js` 里有两条测试专门钉住这件事（含「宿主从不报 idle」的情形）。

## 环境要求

- **Windows**。用的是 WinRT 的 toast API，别的平台没有这个东西；不是 Windows 时插件会记一条 warning 并安静地不工作，不会让宿主启动失败。
- Node `^22.19.0 || >=24.0.0`。
- 通知由 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（系统自带的 Windows PowerShell 5.1）弹出，**不需要**安装 BurntToast 之类的模块，也没有任何第三方依赖。

通知不出现时，常见原因是 **专注助手（Focus Assist）／勿扰模式**被打开，或者系统通知被整体关掉了。日志里会有一条 `dsh-notify:` 开头的记录说明结果。

## 它是怎么做的（给想看代码的人）

代码分三层，每层只做一件事：

| 文件 | 职责 |
| --- | --- |
| `lib/format.js` | 纯函数：结束原因映射成通知类型、Markdown 压成一行、截断、拼出最终文案。**不碰任何 I/O**，所以规则本身可以被测试读清楚。 |
| `lib/powershell-toast.js` | 只负责把一段标题/正文变成一条真正弹出来的 Windows 通知。 |
| `lib/index.js` | 只有一个职责：接事件。也就是上面那套「回合结束只记录、agent 空闲才通知」的接线。 |
| `lib/config.js` | 把配置收敛成可依赖的值——手写进 profile 的非法值也要能兜住。 |

几点实现上的取舍：

- **会话文本永远不进命令行。** 标题里可能有引号、换行、`$`、反引号、分号，任何一种都能改变一条命令的含义。所以文本走 stdin，脚本模板本身是一个不含插值点的常量。没有 shell 字符串可拼，也就没有转义代码。
- **传输层是纯 ASCII。** Windows PowerShell 通过控制台代码页读 stdin，直接写 UTF-8 字节在中文机器上会变成乱码（这正是开发时踩到的坑）。所以非 ASCII 字符统一编码成 `\uXXXX` 转义再传，与机器代码页无关。
- **XML 值都过 `SecurityElement::Escape`**，AppUserModelID 用单引号字面量并双写 `'`——脚本里仅有的两个插值点都封住了。
- **一条通知只弹一次。** 通知失败、会话被关掉、摘要读不出来，都只记日志，不会去打扰 agent 回合本身，也不会变成宿主里的 unhandled rejection。

## 开发

```sh
npm run link:peers   # 把宿主正在用的 schemastery 链到 node_modules（插件不 import cordis）
npm test             # 36 项：决策规则 + 事件接线（用注入的假传输，不会真弹通知）
npm run smoke        # 需要真实桌面：校验 Config schema，然后真弹一条通知
node scripts/preview-toast.mjs   # 只弹一条，用来看真实排版
```

`test/` 里没有任何一项会真的弹通知：`apply()` 的第三个参数是注入的传输层，测试传一个记录用的假实现。

### 装进真实宿主

**装一个插件要动 profile 里两个地方，它们被系统的不同部分读取**——只做一半会出现「插件在跑但界面上找不到」：

| 写在哪里 | 谁读它 | 漏了会怎样 |
| --- | --- | --- |
| `dsh.profile.bundles` | 加载器（启动时合成） | 插件根本不运行 |
| `dependencies` | **Settings → 插件 的「已安装」列表** | **插件在跑，但列表里看不到、没有开关** |

两条命令（都要在**完全退出 DSH 之后**跑）：

```sh
# 1) 让它被加载
node scripts/set-bundle-state.mjs --name dsh-notify-toast --action enable --link <本仓库路径>
# 2) 让它出现在插件列表里、可以开关
node scripts/register-local-plugin.mjs --name dsh-notify-toast --dir <本仓库路径>
```

然后启动 DSH，随便跑一个任务。

Windows 上没有 `node` 在 PATH 时用包装脚本（它会自己找 DSH 自带的那份）：

```bat
scripts\set-bundle-state.cmd --name dsh-notify-toast --action enable
```

撤销：`set-bundle-state.mjs --action disable`，并把 `register-local-plugin.mjs` 写进 `dependencies` 的那一行删掉（它会留备份）。

> 这个「只做一半」是我实际犯过的错：插件装好后通知一切正常，但用户在 **Settings → 插件** 里找不到它，
> 因为那个列表是按 `dependencies` 列的。对照物是 `dsh-custom-instructions`——它能出现在列表里，
> 正是因为它的 `dependencies` 里有 `file:` 声明。

三个必须知道的约束，都是踩过的：

- **运行中的宿主会回写配置。** 实测：写入后 20 多秒被内存状态覆盖回原样——先「看起来成功」，再静默失效。所以脚本会**先检测 DSH 是否在跑并直接拒绝**，别绕过它。
- **新插件必须先成为 bundle。** profile 的 `cordis.patch.yml` 是*按 id 覆盖已有条目*的层，往里面写 `- id: 一个还没加载的插件` 只会留下一个指向不存在目标的 patch 行，而 DSH 的启动是 all-or-nothing，整个宿主起不来。正确做法是加进 profile 的 `dsh.profile.bundles`，由加载器读该包自己的 `dsh.bundle.patch`（`insert:` 行）插入条目。
- **别用 PowerShell 改这个 JSON。** 早期版本用 PowerShell 写，在 Windows PowerShell 5.1 上正常，在 PowerShell 7 上 `ConvertFrom-Json`/`ConvertTo-Json` 往返会产出带尾随逗号的 JSON，DSH 直接拒绝启动（`Unexpected token ', {'`）。现在这段逻辑由 `set-bundle-state.mjs` 用 Node 的 JSON 实现完成——一份实现、处处相同，且写入前会重新解析确认合法。旧的 `.ps1` 保留仅为存档，**不要再使用**。

## 排查：通知不出现

按这个顺序查。**先确认「加载了没有」，再怀疑逻辑**——这两类故障的表象完全一样（什么都不发生），但排查方向相反：

1. **插件有没有进入加载器树**（最关键，也最容易忽略）
   在 `list_plugins` 里找 `include:dsh-notify`：

   | 看到什么 | 含义 |
   | --- | --- |
   | **条目不存在** | `cordis.patch.yml` 没解析成功（见第 2 条），插件根本没加载 |
   | **`fiberPhase: "pending"`** | 在等某个服务——检查是否声明了不需要的 `inject` |
   | **`fiberPhase: "active"`** | 插件在运行，这才轮到看逻辑 |

   ```sh
   node scripts/verify-bundle-resolves.mjs --profile ~/.dsh/profiles/desktop
   ```

2. **`cordis.patch.yml` 的两个静默陷阱**——都会让插件完全不加载，且不报任何错
   - **缩进里有 tab**：YAML 禁止 tab，整份文档解析失败，加载器一声不响地丢掉 `insert`
   - **`config:` 没有子项**：把配置键写成了 `config` 的同级键而不是子键

   两条都由 `node scripts/release-check.mjs` 机械校验（含反向验证）。

3. **打开 `debug`**，把每一次决策写进宿主日志：

   ```yaml
   - id: dsh-notify
     name: 'dsh-notify-toast'
     config:
       debug: true      # 8 个空格，且必须是空格
   ```

   日志里会有 `dsh-notify:` 开头的行：收到哪个回合结束、为什么发／不发。

4. **系统层面**：专注助手（Focus Assist）／勿扰模式打开，或系统通知被整体关闭。这类情况下 `showToast` 会成功返回，但通知不显示。

最容易走的弯路：因为「没有通知」就去怀疑事件触发逻辑，而真正的原因在加载阶段。**先看 `fiberPhase`，能省掉大量猜测。**

## License

MIT
