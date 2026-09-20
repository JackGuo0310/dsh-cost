# dsh-cost · DSH 对话费用插件

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 加一条**每轮对话费用**：每轮回答结束后显示本轮花费和当前会话累计花费，点一下展开明细。

> 仓库：https://github.com/JackGuo0310/dsh-cost

```
你 ─────────────────────────────────────────────
AI ─────────────────────────────────────────────
   本轮 ¥0.0321 · 累计 ¥1.8432 · 缓存 92%        ← 本插件
   🗄 用量 2.2M tok   ⏱ 用时 2分23秒              ← DSH 自带
```

数据来源是 DSH 已经采集好的 token 用量（未缓存输入 / 缓存命中 / 缓存写入 / 输出），不拦截 API、不额外请求、不改 DSH 源码。

---

## 1. 安装

先把仓库放到本地（已有本地目录可跳过）：

```powershell
git clone https://github.com/JackGuo0310/dsh-cost.git D:\Github\dsh-cost
```

### 方式 A：脚本安装（推荐）

```powershell
cd D:\Github\dsh-cost
node scripts\install-local.mjs
```

脚本做三件事：

1. 把包复制到 `~/.dsh/profiles/web/node_modules/dsh-cost`；
2. 往 `~/.dsh/profiles/web/cordis.patch.yml` 追加一行 Loader 入口；
3. 刷新已装 bundle 的时间戳，让已经打开的页面通过 HMR 直接换上新版本。

首次安装后**刷新 DSH 网页**（profile patch 是热加载的；如果没出现，重启 `dsh web`）。之后每次改完代码重跑这个脚本即可，不用再手动刷新。

参数：`--profile <dir>` 指定其它 profile，`--no-patch` 只复制文件，`--uninstall` 卸载。

### 方式 B：手动安装

1. 复制（或 `link:` / `pnpm add`）到 profile 的 `node_modules`：

   ```powershell
   Copy-Item -Recurse D:\Github\dsh-cost "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-cost"
   ```

2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-cost
         name: dsh-cost
   ```

3. 刷新网页。

> 想要 `pnpm install` 之后依然存在，就把 `"dsh-cost": "link:D:/Github/dsh-cost"` 写进 profile 的 `package.json` 依赖里，而不是手动复制。

### 方式 C：作为 bundle

把 `dsh-cost` 加进 profile `package.json` 的 `dsh.profile.bundles`（依赖写成 git 地址或 npm 包名），包内的 `cordis.patch.yml` 会自动插入入口 —— 这时**不要**再手动加方式 B 的那一行，否则会插入两次。

---

## 2. 计费口径

价格镜像自 DeepSeek 官方 [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 页（**2026-09-10** 版），单位为「元 / 百万 tokens」：

| 计费项 | deepseek-flash 空闲 | deepseek-flash 高峰 | deepseek-v4-pro 空闲 | deepseek-v4-pro 高峰 |
| --- | --- | --- | --- | --- |
| 输入（缓存命中） | 0.02 | 0.04 | 0.15 | 0.30 |
| 输入（缓存未命中） | 1 | 2 | 4.5 | 9.0 |
| 输出 | 4 | 8 | 13.5 | 27.0 |
| 缓存写入 | 免费 | 免费 | 免费 | 免费 |

**高峰时段**：北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00。其余时间——包括周末和法定节假日全天——都是**空闲时段**，价格为高峰的一半。

DeepSeek 的磁盘缓存不单独收费，所以「缓存写入」单价是 0；DSH 对 DeepSeek 也通常不上报这个桶。

单轮费用 = 四个桶各自 `tokens ÷ 1,000,000 × 单价`，再求和。

---

## 3. 显示与交互

- **位置**：每轮回答下方，DSH 自带的「用量 / 用时」胶囊上方 —— 挂在 Chat 的 `conversation.chat.turnTail` 插槽。
- **胶囊**：`本轮 ¥x · 累计 ¥y · 缓存 z%`。`≈` 前缀表示这一轮是估算（模型不在价目表里，或一轮里用了多个模型）。
- **明细**：点击胶囊展开 —— 本轮合计、模型、计费时段（高峰/空闲）、四个桶的 tokens × 单价 = 金额、本会话累计、已计价轮数、价格表版本与免责声明。
- **未计价**：模型不属于任何已注册价目表时显示「未计价」，而不是猜一个数字。

`累计` 覆盖当前会话**已加载的轮次**（即页面上能看到的那些），不是服务端全量历史。

---

## 4. 改价格 / 加节假日

价格全在 [`client/client.js`](client/client.js) 的 `DEEPSEEK_BOOK` 里，一个数据结构：

```js
const DEEPSEEK_BOOK = {
  id: "deepseek",
  match: (route) => /deepseek/i.test(route.provider ?? "") || /^deepseek[-.]/i.test(route.model ?? ""),
  bucketAt: deepseekBucketAt,                 // 决定用 peak 还是 offPeak
  models: [
    {
      id: "deepseek-flash",
      names: ["deepseek-flash", "deepseek-v4-flash", /* 别名 */],
      rates: {
        peak:    { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 0, output: 8 },
        offPeak: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 0, output: 4 },
      },
    },
  ],
  fallbackModelId: "deepseek-flash",          // 未知模型按谁计价
};
```

**中国法定节假日**无法从时钟推出来，所以是一张清单，默认空：

```js
setDeepSeekHolidays(["2027-01-01", "2027-02-05"]); // 北京时间 YYYY-MM-DD
```

清单缺项只会把某个工作日的费用算高一点，不会算低。周末是自动识别的。

---

## 5. 以后支持其他模型

架构上没有任何地方写死 DeepSeek：所有费用计算都是通用的，只读价目表的 `match` / `models` / `bucketAt` / `currency`。

加一个厂商 = 注册一本新价目表：

```js
registerPriceBook({
  id: "my-provider",
  label: "My Provider",
  currency: "USD",
  updated: "2026-09-01",
  source: "https://example.com/pricing",
  match: (route) => route.provider === "my-provider",
  bucketAt: () => "standard",                  // 没有分时段就固定一个桶
  fallbackModelId: "my-small",
  models: [
    {
      id: "my-small",
      label: "My Small",
      names: ["my-small", "my-small-2026"],
      rates: {
        standard: { cacheHit: 0.05, cacheMiss: 0.5, cacheWrite: 0.6, output: 1.5 },
      },
    },
  ],
});
```

`registerPriceBook` 和整套纯逻辑都通过 `require("dsh-cost").__test` 暴露出来（见下文），所以可以在另一个客户端插件里注册，也可以按下节的方式改源文件。

**扩展点小结**

| 需求 | 改哪里 |
| --- | --- |
| 加一个厂商 / 模型 | `registerPriceBook(...)`，或往 `PRICE_BOOKS` 加一本表 |
| 改价 | 改 `rates` 里的数字 |
| 分时段计费 | 给价目表写 `bucketAt(epochMs)`，返回任意桶名 |
| 分段计价（按上下文长度等） | 在价目表里给 `match` 之外再加逻辑，或让 `rates` 的桶由 `bucketAt` 结合 `tailData` 决定 |
| 用 DSH 之外的用量源 | 复用 `computeTurnCost(tailData)` 的入参形状即可 |

---

## 6. 已知限制

- **是估算，不是账单。** 以 DeepSeek 官方账单为准。缓存命中比例、计费时段边界、法定节假日都可能与实际有细微差异。
- **计费时段按「轮结束时间」判定**，一轮横跨高峰/空闲边界时会整体落到一侧。
- **一轮里换了模型**（重试换模型）时，聚合后的 token 桶无法再按模型拆分，按第一个模型计价并标 `≈`。
- **累计只算已加载的轮次**。长会话滚动翻页之前的轮次不在快照里，因此不在累计中；明细里会显示「已计价 n/m 轮」。
- **法定节假日清单默认是空的**，需要自己填（见上）。
- 失败 / 中断的轮次若没有用量数据，只计入轮数、不计费。

---

## 7. 目录结构

```
dsh-cost/
├─ package.json            # dsh.client.platform=web + exports["./client"]
├─ cordis.patch.yml        # bundle 方式用的插入补丁
├─ lib/index.js            # host 半：空实现，只为让包成为 Loader 行
├─ client/client.js        # 浏览器半：预构建 bundle（价格表 + 费用计算 + UI）
├─ scripts/install-local.mjs
├─ test/client.test.mjs    # 35 个用例（含真实 React 渲染）
└─ README.md
```

`client/client.js` 是**预构建产物，也是可读源码**：DSH 把客户端插件当普通 `<script>` 加载，脚本只需要用 `window.__ModuleLoader__.load({ id, factory })` 注册一个工厂，工厂里只能 `require` 壳提供的种子模块（`react`、`react/jsx-runtime` 等）。本插件只用到 `react` 和 `react/jsx-runtime`，所以没有构建步骤、**没有运行时依赖** —— 你读到什么，浏览器就跑什么。（`react` / `react-test-renderer` 只是 devDependencies，用来跑测试。）

---

## 8. 开发

```powershell
npm install      # 只装 devDependencies（react + react-test-renderer）
npm run check    # 语法检查 client/client.js 与 lib/index.js
npm test         # 35 个用例
```

测试用一个假的 `window.__ModuleLoader__` 捕获工厂，再用**真实的 react / react/jsx-runtime** 物化模块，所以跑的就是浏览器里的那份代码：

- **纯逻辑**：价目表匹配与别名、高峰/空闲边界（含周末与节假日）、四个桶的费用计算、未知模型回退、多路由标记、快照汇总与签名、缓存命中率、格式化。
- **注册面**：`name` / `inject` / `apply` 的形状，字典与 slot 注册项（含 `id`、`order`、`locale`、`label` thunk）。
- **真实渲染**（`react-test-renderer`）：胶囊文案、点击展开明细、逐行单价与金额、累计与已计价轮数、未计价与 `≈` 估算、中英文文案、无用量时不渲染。
- **回归护栏**：每次渲染都在捕获 `console.error`；最后一个用例断言整个文件没有产生任何 React 警告（缺 key、非法属性都会在这里炸出来）。字典键缺失同样会被抓出来——`t()` 会把查不到的 key 记下来并断言为空。

改完 `client/client.js` 后：

- 重新执行一次 `node scripts/install-local.mjs`：它会把包同步到 profile，并刷新已安装 bundle 的时间戳，让已经打开的页面通过 HMR 直接换上新版本，不用手动刷新；
- 首次安装（profile 里还没有这一行）仍需刷新页面或重启 `dsh web`；
- 想在改动时自动重新打包，需要在 DSH 源码 checkout 里跑 `pnpm run dev:web`，本仓库没有构建链。

---

## 9. 卸载

```powershell
node scripts\install-local.mjs --uninstall
```

然后删掉 `~/.dsh/profiles/web/cordis.patch.yml` 里那段 `dsh-cost` 入口，刷新网页。

---

## License

MIT
