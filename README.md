# 115 云下载失败任务一键重试 / One-Click Retry for Failed 115 Cloud-Download Tasks

> 中文 | [English](#-english)

115 网盘的「云下载」（离线下载）任务失败后没有自带重试功能，只能手动删掉失败条目、重新添加链接。
本油猴脚本在 115.com 页面右下角加了一个悬浮按钮，实现**一键全部重试**和**单个重试**。

When a 115 cloud-download (offline download) task fails, 115 gives you no built-in retry —
you have to delete the failed entry and re-add the link manually.
This userscript adds a floating button on 115.com pages that lets you **retry all failed tasks
with one click** or **retry a single task**.

## 功能 / Features

- **一键全部重试**：自动把所有失败任务按「原链接 + 原保存目录」重新添加（先删除旧的失败记录）
  One-click retry-all: every failed task is re-added with its *original link* and *original save
  directory* (the stale failed record is removed first)
- **单个重试**：每个失败任务旁有独立「重试」按钮
  Per-task retry button on every failed task
- **保存目录可读化**：每行显示任务原始保存目录的完整路径（自动解析 cid），
  重试时按该目录重新添加，文件会落回失败前的位置
  Human-readable save directory on every row (cid auto-resolved to a full path);
  retry always re-adds to that same directory
- **复制全部链接**：需要手动处理时可一键复制所有失败任务的链接
  Copy-all-links for the few tasks that need manual handling
- 扫描带时间预算 + 「继续扫描」，任务再多也不卡界面；进度条 + 中途停止
  Time-budgeted scanning with a "continue scanning" option, live progress, and a stop button
- 请求间隔与请求超时可在面板内调整（自动记忆）
  Adjustable request interval and per-request timeout, remembered automatically
- 只在已登录的 115.com 页面内发同域请求，登录 Cookie 不外发
  All requests stay on 115.com in your logged-in session; no cookie ever leaves the site

## 安装 / Installation

前置条件：安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox）
或 [Violentmonkey](https://violentmonkey.github.io/)（Firefox / Chromium）。

Prerequisite: install [Tampermonkey](https://www.tampermonkey.net/) (Chrome / Edge / Firefox)
or [Violentmonkey](https://violentmonkey.github.io/) (Firefox / Chromium).

**方式一：一键安装 / One-click**

在浏览器中打开下面的原始脚本地址，Tampermonkey 会提示安装：

Open this raw script URL in your browser and Tampermonkey will offer to install it:

<https://github.com/zhaoshuocool/115-retry-offline/raw/main/115-retry-offline.user.js>

**方式二：手动 / Manual**

1. Tampermonkey → 「添加新脚本」/ create a new script
2. 粘贴 `115-retry-offline.user.js` 全部内容并保存 / paste the file content and save
3. 浏览器登录 <https://115.com/>，页面右下角出现蓝色按钮 **「↻ 重试失败任务」**
   Log in to 115.com — a blue **「↻ 重试失败任务」** button appears at the bottom right

## 使用方法 / Usage

1. 点右下角按钮，脚本拉取失败任务（状态 `-1`）列出在面板里；扫描默认 20 秒为一个批次，
   列表多时点 **「继续扫描」** 接着拉
   Click the button; failed tasks (status `-1`) are listed in the panel. Scanning runs in
   ~20-second batches — click **「继续扫描 / Continue scanning」** if you have many tasks
2. 点 **「全部重试 / Retry all」**：逐个执行「删除旧失败记录 → 按原链接重新添加到原目录」，
   带进度条和停止按钮
   One-by-one "delete stale record → re-add original link to original directory", with a
   progress bar and stop button
3. 只想重试某一条：点该行右侧的 **「重试 / Retry」**
   Or retry a single task with the button on its row
4. 完成后 **刷新 115 页面** 查看新任务（115 网页端不会自动刷新传输列表）
   Then **refresh the 115 page** — the web UI won't auto-refresh the transfer list

## 原理 / How it works

脚本调用 115 网页版离线（云下载）接口（端点整理自社区项目
[elevengo](https://github.com/deadblue/elevengo) 和
[JavPack](https://github.com/bolin-dev/jav-pack-script)）：

The script calls 115's web offline-download endpoints (documented from the community projects
[elevengo](https://github.com/deadblue/elevengo) and
[JavPack](https://github.com/bolin-dev/jav-pack-script)):

| 操作 / Operation | 接口 / Endpoint | 说明 / Notes |
|---|---|---|
| 任务列表 / Task list | `GET https://115.com/web/lixian/?ct=lixian&ac=task_lists&page=N` | 返回 `tasks[]`，含 `url`（原始链接）、`wp_path_id`（保存目录 cid）、`status`、`info_hash` 等 / returns the original link, save dir, status and hash per task |
| 重新添加 / Re-add | `POST ...?ct=lixian&ac=add_task_url` | 表单字段 `url`、`wp_path_id`；`errcode=10008` 表示同任务已存在 / `errcode=10008` means a task with the same hash already exists |
| 删除旧记录 / Delete | `POST ...?ct=lixian&ac=task_del` | 表单字段 `hash[0]`（`info_hash`） |
| 目录名解析 / Resolve dir name | `GET https://webapi.115.com/files?cid=N` | 仅用于在面板里显示保存目录的完整路径 / display only |

「重试」= 先删旧失败记录，再按原链接和原目录重新添加，等价于手动操作但可以批量。
**重新添加时会带上任务的 `wp_path_id`（原保存目录 cid），所以文件一定落回失败前所在的目录**（目录被删等异常时面板会显示 cid 并报错）。

"Retry" = delete the stale failed record, then re-add the same link to the same directory —
the same as doing it by hand, but in batch.
**The re-add request carries the task's `wp_path_id` (original save-directory cid), so the
file lands back in exactly the directory it failed in** (if that directory no longer exists,
the panel shows the cid and the task errors out visibly).

## 可调参数 / Configuration

脚本顶部 `CONFIG`（面板内可改的两项会持久化到 localStorage）：

Top-level `CONFIG` in the script (the two panel inputs are persisted to localStorage):

| 参数 / Key | 默认 / Default | 说明 / Description |
|---|---|---|
| `delayMs` | 800 | 每个任务操作间隔（毫秒），触发限流就调大 / per-task interval; raise it if rate-limited |
| `requestTimeoutMs` | 30000 | 单个请求超时（毫秒），面板按秒调整 / per-request timeout (panel input is in seconds) |
| `maxPages` | 100 | 拉列表的最大页数 / max pages to fetch |
| `scanSeconds` | 20 | 单次扫描时间预算（秒），到点提供「继续扫描」 / per-batch scan time budget |
| `deleteOld` | `true` | 添加前是否先删除旧的失败记录 / delete the stale record before re-adding |
| `failedStatus` | `-1` | 视为失败的状态码（115：-1 失败 / 1 进行中 / 2 完成）/ status treated as "failed" |

接口地址集中在脚本顶部 `API` 对象里，115 改版后若失效只需改这一处。

All endpoint URLs live in the `API` object at the top of the script — the only place to touch
if 115 changes its API.

## 常见问题 / Troubleshooting

- **一直停在「正在加载失败任务列表」**：打开控制台（F12），找
  `[115-retry] task_lists 第 1 页响应:` 日志，把 JSON 反馈给脚本作者即可定位接口变化；
  「接口返回非 JSON」多半是登录态失效，先重新登录
  If loading hangs: open DevTools (F12), find the `[115-retry] task_lists page 1 response:`
  log and report it; "non-JSON response" usually means your login expired — log in again
- **某条任务提示「任务已存在」**：网盘里已有同 hash 任务（如还在下载中），无需处理
  "Task already exists" means an identical task is already in the queue (e.g. still
  downloading) — safe to ignore
- **「缺少链接，无法自动重新添加」**：极少数任务记录没有原始链接，需手动复制磁链添加
  "Missing link": a rare record type without an original URL — re-add it manually
- **报错 `errcode=911` 等**：多为验证/配额/风控类错误，按 115 页面提示操作
  `errcode=911` etc. usually means verification, quota or risk-control — follow 115's prompts

> ⚠️ 本脚本仅调用 115 官方网页接口操作自己的账号，请保留合理请求间隔，避免触发风控。
> 115 接口非官方文档，可能随版本变化。
>
> ⚠️ This script only calls 115's own web API against your own account. Keep the request
> interval reasonable to avoid risk control. The API is undocumented and may change.

<a name="-english"></a>
## English

<details>
<summary>Click to expand the full English documentation</summary>

### About

115's cloud-download ("offline download") feature has no retry button: a failed task must be
deleted and re-added by hand. This userscript adds a floating
**「↻ Retry failed tasks」** button to every 115.com page that:

- **Retries all failed tasks in one click** — each task is re-added with its original link and
  original save directory (the stale failed record is deleted first)
- Offers a **per-task retry** button, **copy-link** and **copy-all-links** actions
- Scans the task list in **time-budgeted batches** (~20 s) with a *continue scanning* button,
  a live progress bar and a stop control
- Lets you tune the **request interval** and **request timeout** in the panel (persisted)

Everything runs same-origin on 115.com with your logged-in cookies; nothing is sent anywhere
else.

### Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox) or
   [Violentmonkey](https://violentmonkey.github.io/) (Firefox/Chromium).
2. One-click: open
   <https://github.com/zhaoshuocool/115-retry-offline/raw/main/115-retry-offline.user.js>
   in the browser and accept the install prompt.
   Manual: dashboard → *Create a new script* → paste the file → save.
3. Log in to <https://115.com/>. The button appears at the bottom right.

### Usage

1. Click the button. Failed tasks (status `-1`) are listed in the panel. Scanning is batched
   in ~20-second slices — use **Continue scanning** to fetch the rest if you have a long
   history.
2. **Retry all** runs, per task: delete the stale failed record → re-add the original URL to
   the original directory. Progress and a stop button are shown.
3. Or use **Retry** on a single row.
4. Refresh the 115 page afterwards; the web UI does not auto-refresh the transfer list.

### How it works

| Operation | Endpoint | Notes |
|---|---|---|
| Task list | `GET https://115.com/web/lixian/?ct=lixian&ac=task_lists&page=N` | `tasks[]` with `url`, `wp_path_id`, `status`, `info_hash` |
| Re-add | `POST ...?ct=lixian&ac=add_task_url` | fields `url`, `wp_path_id`; `errcode=10008` = task already exists |
| Delete | `POST ...?ct=lixian&ac=task_del` | field `hash[0]` = `info_hash` |
| Resolve dir name | `GET https://webapi.115.com/files?cid=N` | display only — shows the save directory's full path |

Re-adding always passes the task's original `wp_path_id`, so retried files land back in the
exact directory the failed task was saved to.

### Configuration

See the `CONFIG` table above: `delayMs`, `requestTimeoutMs`, `maxPages`, `scanSeconds`,
`deleteOld`, `failedStatus`. The two panel inputs (`操作间隔` / `请求超时`) persist via
localStorage. All endpoint URLs are in the `API` object at the top of the script.

### Troubleshooting

- Loading stalls → open DevTools (F12) and report the
  `[115-retry] task_lists page 1 response:` JSON. "Non-JSON response" usually means an
  expired session — log in again.
- "Task already exists" → an identical task is already queued; nothing to do.
- "Missing link" → rare record without an original URL; re-add manually.
- `errcode=911` (etc.) → verification/quota/risk-control; follow 115's prompts.

> This project only calls 115's own web API on your own account. Keep intervals reasonable
> to avoid risk-control. The API is unofficial and may change without notice.

</details>
