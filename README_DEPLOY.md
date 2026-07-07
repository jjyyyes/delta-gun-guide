# 三角洲行动 S10 配装站上线与自动更新说明

这个目录是从原始 `index.html` 整理出来的可部署版本：

- `index.html`：静态页面，已新增“最新情报”模块。
- `data/latest.json`：前端读取的最新资讯数据。
- `scripts/collect-latest.mjs`：定时抓取 RSS/API/网页标题摘要并写入 JSON。
- `.github/workflows/update-latest.yml`：每 6 小时自动抓取一次并提交结果。
- `.github/workflows/deploy-pages.yml`：推送到 `main` 后自动部署到 GitHub Pages。

## 1. 配置抓取来源

编辑 `config/sources.json`，把示例源替换成真实来源，并把 `enabled` 改成 `true`。

推荐优先使用：

- 官方公告 RSS 或 API。
- 社区攻略站 RSS。
- 你自己维护的 Notion/飞书/表格导出的 JSON API。

没有 RSS/API 时可以用 `type: "html"`，脚本会读取页面标题和描述；复杂列表页建议后续改成专门解析规则，避免被反爬或抓错内容。

## 2. 本地生成数据

```bash
npm run check
npm run update:data
```

生成后用本地静态服务预览，页面会读取 `data/latest.json`：

```bash
python -m http.server 8087
```

然后访问 `http://127.0.0.1:8087/`。不建议直接双击 `index.html`，部分浏览器会限制本地文件读取 JSON。

## 3. 部署到 GitHub Pages

1. 在 GitHub 新建仓库。
2. 把本目录内容推送到仓库 `main` 分支。
3. 打开仓库 `Settings -> Pages`，Source 选择 `GitHub Actions`。
4. 在 `Actions` 页手动运行一次 `Deploy static site to GitHub Pages`。
5. 之后每次推送代码或自动更新数据，都会重新部署。

## 4. 私密或较长的来源配置

如果不想把抓取来源写进仓库，可以在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 新增：

- Secret 名称：`LATEST_SOURCES_JSON`
- Secret 内容：完整 JSON，例如：

```json
{
  "maxItems": 24,
  "sources": [
    {
      "name": "官方公告",
      "type": "rss",
      "url": "https://example.com/feed.xml",
      "enabled": true
    }
  ]
}
```

工作流会优先读取这个 Secret。

## 5. 后续建议

- 先接 2-3 个稳定来源，确认内容质量后再扩展。
- 枪械配装数据建议下一步从 `index.html` 中拆到 `data/weapons.json`，这样更新配装不用改页面代码。
- 如果要做实时搜索、评论、投稿审核或登录后台，建议改成 Cloudflare Pages + Workers 或 Vercel + Cron，而不是只用静态 Pages。
