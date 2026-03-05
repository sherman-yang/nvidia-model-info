# nvidia-model-info

这个项目用于显示 `build.nvidia.com` 可用的免费模型信息，并通过 model metadata endpoint 展示每个模型的全部字段。

## 功能

- 自动拉取模型列表，并仅保留 Active/可使用模型展示
- 对每个模型调用 metadata endpoint（`GET https://integrate.api.nvidia.com/v1/models/{publisher}/{model}`）
- 以列表表格展示所有字段（包含扁平化后的 metadata）
- 所有列可点击排序（升序/降序）
- 支持关键字过滤
- 默认每 10 分钟自动刷新一次数据
- 页面上提供“强制刷新数据”按钮，可手工刷新
- 在模型行上点击鼠标右键可弹出 API 使用示例（cURL / Python / JavaScript），并支持一键复制到剪贴板
- 程序启动后自动打开浏览器窗口

## 环境要求

- Node.js 18+

## 配置

1. 必须在系统环境变量中设置 API key（不要写入 `.env`）：

```bash
export Sherman_NVDA_test="你的NVIDIA_API_KEY"
```

也可以只在单次启动时注入：

```bash
Sherman_NVDA_test="你的NVIDIA_API_KEY" npm start
```

2. `.env` 只用于非敏感参数（可选）：

```bash
cp .env.example .env
```

说明：程序会忽略 `.env` 中的 `Sherman_NVDA_test`，仅从系统环境变量读取该 key。

## 运行

```bash
npm install
npm start
```

默认会自动打开 `http://localhost:4920`。

也可以直接一键安装并运行：

```bash
./start.sh
```

`start.sh` 会自动检查 `Sherman_NVDA_test` 是否已设置、安装依赖并启动服务。

## 可选配置

- `PORT`：端口，默认 `4920`
- `MAX_CONCURRENCY`：并发请求 metadata 数量，默认 `12`
- `REQUEST_TIMEOUT_MS`：单个请求超时（毫秒），默认 `20000`
- `CACHE_TTL_MS`：服务端缓存有效期（毫秒），默认 `300000`
- `OPEN_BROWSER`：是否自动打开窗口，`1`/`0`，默认 `1`

## API

- `GET /api/health`
- `GET /api/models-with-metadata`
- `GET /api/models-with-metadata?refresh=1`（强制刷新）

说明：`/api/models-with-metadata` 返回的 `rows` 始终是 Active/可使用模型；并附带
`totalModelCount` 与 `filteredOutCount` 用于显示过滤统计。
