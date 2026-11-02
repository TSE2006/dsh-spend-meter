# 花费与余额（spend-meter）

**简体中文** | [English](README.en.md)

在输入框下方常驻一条 `¥3.89 本对话 · 余额 ¥19.07`，点开是本对话账本。

![输入框下方的药丸](docs/preview.png)

点开之后是这笔账：

<img src="docs/panel.png" width="380" alt="账本面板：分项花费、联网搜索、预算、近 14 天趋势、余额">

往下还有按模型的花费、逐轮成本和价目表来源：

<img src="docs/detail.png" width="380" alt="账本下半部分：按模型花费、按模型族近似计价提示、逐轮成本、价目表更新时间">

样式刻意贴合 DSH 自带的两处 UI：药丸照 `StatsPills`（`3 轮 228 步 · 232 tok/s`、`20.9M tok · 缓存命中 96%` 同款裸文字按钮），弹层照 `stat-dialog`（「Token 用量」那张卡片的背景、圆角、阴影、分隔线、右对齐等宽数字）。全部设计令牌取自运行时的 `--dsw-*` / `--dsh-*` 变量，浅色/深色主题自动跟随。

## 安装

需要 DSH 0.2.1-rc.5 及以上的桌面端（插件以 bundle 形式注册到 profile）。

1. 把整个目录放到任意位置，例如 `%USERPROFILE%\.dsh\plugins\spend-meter`。
2. 在 DSH 里让 Agent 执行 `plugin_manager` 的 `install_bundle`，`target` 填该目录的**绝对路径**；插件管理器里也会显示为「花费与余额」。
3. 输入框下方出现 `¥0.00 本对话 · 余额 ¥0.00` 即安装成功。

包名固定为 `@local/spend-meter`（本地包惯例），无需发布到 npm。

## 显示什么

| 位置 | 内容 |
| --- | --- |
| 常驻药丸 | 本对话花费、平台余额（低于 ¥5 变黄、低于 ¥1 变红）；高峰时段 ¥ 图标变黄，空闲时段保持灰色 |
| 账本 · 时段 | 现在是否高峰，以及距下一个半价/高峰时段还有多久 |
| 账本 · 花费 | 输入未命中缓存、输入命中缓存、输出、联网搜索、自动压缩摘要，各自金额、token 数与实际折算的单价（每百万 tok，高峰/空闲混合时为加权值，乘一下就能核对金额） |
| 账本 · 缓存 | 缓存命中省下的钱，以及「如果没有缓存本来要花多少」 |
| 账本 · 余额 | 充值余额 + 赠送余额，以及还能聊多少轮；配置了预算时按「钱包余额 / 今日预算 / 本月预算」三者中最先见底的那个算 |
| 账本 · 预算 | 今日 / 本月已花与上限（配置了 `budget` 才显示），达到 80% 变黄、超支变红并给出提示；届时输入框上方的金额也会跟着变色，悬停可看到今日百分比 |
| 超支提示条 | 预算用完后在药丸右侧出现一条，点 × 关闭；同一天（或同一月）只提示一次，关闭后不再出现 |
| 账本 · 近期 | 最近 14 天的花费柱状条（今天高亮，悬停看当天金额）与「本周」合计（周一为起点，跨会话累计） |
| 账本 · 价目 | 价目表来自在线更新时注明「价目表：<日期> 更新」，更新失败时注明原因；内置价目表不额外占位 |
| 账本 · 细分 | 「联网搜索」按工具拆（`web_search` / `web_fetch` 各自次数与金额），「自动压缩摘要」按写摘要的模型拆 |
| 账本 · 模型 | 按模型拆分的金额（多模型会话才显示） |
| 账本 · 逐轮 | 最近 8 轮各自的成本，点「展开更早 N 轮」可看到全部 |
| 账本 · 导出 | 底部「复制 Markdown / 复制 CSV」把整本账（分项、token、余额、预算、按模型、逐轮）复制到剪贴板，方便贴进笔记或对账 |
| 账本 · 链接 | 跳转 DeepSeek 平台「查看用量 / 去充值」 |

## 数据从哪来

**花费**：Host 半注册一个 session 投影 `spendMeter`，只读会话事件流，因此重启、切会话都不丢：

- `assistant/message` / `assistant/attempt` 的 `usage` → 按 `(turn, step)` 归户；重试会先扣掉旧样本再计新的，不会重复计费。
- `compaction/summary` 的 `usage` → 单列为「自动压缩摘要」的隐藏成本。
- `tool/call` 里 `web_search` / `web_fetch` → 按次计价（默认 ¥0.005/次，2026-11-01 起收费）。
- 价格按**每条事件自己的时间戳**判断高峰/空闲：北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰，其余为半价。

**余额**：由 Client 半直接调 `account` Remote（`ctx.remote.account.getBalance(...)`，和「设置 → 账户」走同一条路），每 15 秒刷新一次，窗口重新可见或点开账本时也会立刻刷新。

投影视图里的 `wallet` 字段仍然保留，作为 Remote 尚未返回时的兜底值。之所以不能只靠投影：投影只在**会话事件**让状态换新引用时才重算并广播，钱包轮询既不产生事件、也不改状态，冷启动后页面会一直停在 baseline 抓到的那份 `loading` 上。

余额这条调用**不写进 `inject`**，而是运行时用 `ctx.get` 解析：Cordis 没有 optional 注入，硬 inject 一个尚未挂载的服务会让条目 pending，而桌面端 web boot 把「任一条目没激活」视为致命错误。

**预算**：投影状态里带一个按北京时间日期分桶的 `days` 映射，每次事件只把**金额增量**记到该事件自己那一天的桶里（重试替换产生的负增量会自动抵扣）。Host 半再把各会话的桶汇总成今日/本月：

- 落盘文件：`%USERPROFILE%\.dsh\spend-meter-ledger.json`（设了 `DSH_PROFILE_DIR` 时放在该目录下，也可用环境变量 `SPEND_METER_LEDGER` 直接指定路径；保留最近 70 天），重启后接着算。
- 汇总顺序：磁盘台账 → 本次运行里见过的会话（`sessionProjections.onChanged` 推送的绝对值）→ 当前会话自己的 `days`（最后覆盖，避免「最后一个事件还没广播」的滞后）。
- 没有配置 `budget` 时不产生这个字段，弹层里也就不显示预算小节。
- 「近期」柱状条和周合计来自同一份台账，取最近 14 天的日桶；一周从北京时间的周一开始算。台账还全是 0（刚装好）时不显示这一节。

## 稳健性

客户端半分不会把异常抛给 Cordis（否则整个应用起不来）：

- `apply` 里的每一步（字典、样式、挂载）都用 `guard()` 包住，失败只记进 `problems`。
- `buildPanel()` 整体 try/catch，失败时药丸降级为 `—`，弹层由 `PanelBoundary` 兜住。
- 样式一律用 CSS 类，不传字符串给 `style`（React 要求对象，传错会在渲染期抛错并被 slot 运行时静默移除整个 cell）。

排障时插件自己的诊断写在浮层底部的「插件异常」块里。

## 价目（内置默认值，可在 patch 的 `config` 覆盖）

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- |
| deepseek-flash（含 v4-flash 别名） | ¥0.04 / ¥0.02 | ¥2 / ¥1 | ¥8 / ¥4 |
| deepseek-v4-pro | ¥0.30 / ¥0.15 | ¥9 / ¥4.5 | ¥27 / ¥13.5 |

单位：元 / 百万 tokens，格式为「高峰 / 空闲」。查表顺序是：先精确匹配模型名，再抹掉日期/版本尾巴（如 `-1017`、`-20250929`）匹配，最后才按名字族回退——名字里带 `deepseek` 且含 `flash` 按 flash 价、含 `pro` 按 pro 价。走到第三级时弹层会注明「按模型族近似计价：<模型>」。其余模型计入 `unpriced`，不参与金额合计。

`config.models` 里既可以用上面的 `peak` / `offPeak` 写法，也可以用**平价写法**（一个价全天生效，适合不区分时段的第三方渠道）：

```yaml
    models:
      deepseek-v4.1-flash-1017: { cacheHit: 0.02, cacheMiss: 1, output: 4 }   # 平价，峰谷同价
```

### 价目在线更新

内置价目表会过期，所以 Host 半每天去本仓库拉一次 `pricing.json`（设置项见下）：

- 地址：先试 `https://cdn.jsdelivr.net/gh/TSE2006/dsh-spend-meter@main/pricing.json`（部分网络解析不到 raw.githubusercontent.com），失败再试 `https://raw.githubusercontent.com/TSE2006/dsh-spend-meter/main/pricing.json`；可用环境变量 `SPEND_METER_PRICING_URL` 指向自建镜像（此时只用这一个地址）。
- 缓存：`%USERPROFILE%\.dsh\spend-meter-pricing.json`，24 小时内不重复请求；拉取失败时继续用上一份缓存或内置表，只在弹层里提示失败原因。
- 优先级：`config.models` > 在线/缓存表 > 内置表；合并是逐模型的，所以只补新模型也会生效。
- 关掉：`config.autoPricing: false`，或把 `SPEND_METER_PRICING_URL` 指向不可达地址（不推荐）。
- 维护：新模型上线后改仓库根的 `pricing.json` 即可，用户无需升级插件。

## 计费口径

分子分项全部来自 DSH 记录的 usage 事件，不额外请求平台账单：

| 分项 | 取自 | 说明 |
| --- | --- | --- |
| 未命中输入 | `usage.inputTokens` | 真实日志里满足 `totalTokens = inputTokens + outputTokens + cacheReadTokens`，所以这是**未命中**部分，不会是全量 prompt |
| 命中输入 | `usage.cacheReadTokens` | 按命中价计；同时算出「缓存省下」= 这部分若按未命中价要花多少 |
| 输出 | `usage.outputTokens` | 推理模型把思考计入输出，就一并按输出价算；usage 里没有独立的 reasoning 字段可拆 |
| 缓存写入 | `usage.cacheWriteTokens` | 实测所有事件恒为 0（DeepSeek 不单独报缓存创建），若某个 provider 报了，按未命中价计 |

只有**成功返回**的 `assistant/message` 带 usage。失败的请求（例如 401）落在 `assistant/attempt` 上，usage 全 0，因此**不计费**——这一点与实际账单一致。同一 `turn/step` 重复上报时会用后一次替换前一次（重试不重复计费）。

联网搜索按次计费（默认 ¥0.005/次，`searchFreeUntil` 之前免费），自动压缩摘要的 LLM 花费单列为「压缩摘要」。

## 配置示例

在 profile 的 `cordis.patch.yml`（`%USERPROFILE%\.dsh\profiles\<profile>\`）里给 `spend-meter` 行加 `config`：

```yaml
- id: spend-meter
  config:
    holidays: ['2026-10-01', '2026-10-02']   # 法定节假日全天按空闲价
    searchPerCall: 0.005
    turnHistory: 120
    currency: CNY
    budget:
      daily: 20            # 今日上限，单位同 currency；不配或填 0 表示不限
      monthly: 200         # 本月上限
      warnRatio: 0.8       # 到这个比例变黄，超过 100% 变红并提示
    autoPricing: true      # 设为 false 则只用内置价目表，不联网更新
    models:
      deepseek-flash:
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
        offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
```

> 本插件不声明 `Config`，`config` 不做 schema 校验，字段全部按上表兜底。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：投影 `spendMeter`（花费账本 + 日桶）+ 跨会话台账 + 钱包兜底轮询 |
| `client.ui.js` | Client 半源文件（药丸、弹层、CSS、字典） |
| `client.js` | 部署产物，内容与 `client.ui.js` 相同 |
| `locale/{en,zh}.json` | 插件管理器里显示的标题与说明 |
| `icon.svg` | 插件图标 |
| `pricing.json` | 在线价目表，Host 半每天拉取一次合并到内置表 |
| `cordis.patch.yml` | bundle 插入声明 |
| `README.md` / `README.en.md` | 中文 / 英文文档 |
| `CHANGELOG.md` | 版本记录 |
| `docs/preview.png` | 药丸截图 |
| `docs/panel.png` | 账本弹层截图（上半：分项、预算、趋势、余额） |
| `docs/detail.png` | 账本弹层截图（下半：按模型、逐轮成本、价目表） |
| `tests/projection.test.mjs` | Host 半：计价、日桶、预算视图的折叠测试 |
| `tests/client.test.mjs` | Client 半：按内核加载 bundle，渲染药丸与弹层 |
| `.github/workflows/test.yml` | 在 Node 22/24 × Linux/Windows 上跑测试 |

改完源码后：`Copy-Item client.ui.js client.js -Force`，DSH 的客户端模块 HMR 大约 3–4 秒生效，不需要刷新页面。

## 测试

```bash
npm test      # = node --test "tests/*.test.mjs"
npm run smoke # = node scripts/smoke.mjs
```

只依赖 Node 内置的 `node:test` 与 `node:assert`，没有开发依赖。Host 半用假的投影定义直接折叠事件；Client 半把 `client.js` 当作内核那样加载（`__ModuleLoader__.load` + `factory(require)`），用最小的 React/Hook 替身渲染药丸和弹层，所以模块体、字典键、注册参数、外链 handler、预算变色都能在无浏览器的情况下覆盖。

`npm run smoke` 是发布前的冷启动体检：在一个全新进程里（没有 HMR、没有会话基线）核对 `package.json` 承诺的文件都在、`pricing.json` 与 locale 能解析并结构完整、Host 半能在空内核上 `apply` 成功、Client 半能加载并注册槽位、**在投影还没到货时也能渲染**，以及客户端每个 `t('…')` 键在中英字典里都有对应项。桌面端把「任一条目未激活」当作致命错误，这几项正是那类启动事故的护栏，CI 每次都会跑。

## 已知限制

- **价格表以内置值为底、在线更新为补**：内置表是 2026-10 抓取的 DeepSeek 官方价，Host 半每天拉一次仓库根的 `pricing.json` 覆盖同名模型（关网时用缓存或内置值）。要用私有价目就在 profile patch 的 `config.models` 里写，它优先级最高。不在任何表内的模型只统计 token，不计金额，并在弹层底部提示。
- **搜索计费**按官方公告从北京时间 2026-11-01 00:00 起算，之前的 `web_search` / `web_fetch` 记为免费。
- **余额依赖平台账户**：DSH 用 API Key 且未登录 DeepSeek 平台账号时读不到钱包，此时余额位显示 `—`，弹层里给出原因，花费统计不受影响。
- **只统计本会话**：跨会话累计请用平台用量页（弹层底部有入口）。
- **预算从插件开始记账那天算起**：台账只累加本插件看到的事件，装插件之前的历史消费不在其中，所以第一个月的「本月」会偏低；弹层里会用「自 <日期> 起统计」标出来，该日期进入下一个月后就不再显示。
- 账本里的「还能聊约 N 轮」是本会话平均每轮成本外推，长会话里偏差会变大；有预算时取余额与日/月预算里最先见底的那个，并注明是哪一个。
