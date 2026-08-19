# JSONL Summary Lab

用于本地解析、编辑和验证 Claude Code Compact Summary JSONL 记录的纯前端工具。会话内容只在浏览器内存中处理，不会上传到后端。

## 启动

```bash
cd /Volumes/zhitai-7100/personal/cc-haha/jsonl-analysis-tool
bun install
bun run dev
```

开发服务器默认监听 `http://127.0.0.1:5173`。生产构建：

```bash
bun run build
```

`dist/` 是可部署到任意静态文件服务器的输出目录。直接用 `file://` 打开源码页面不可行，因为浏览器不能直接解析源码中的 ESM 裸模块导入。

## 使用流程

1. 粘贴一条完整的 JSONL 记录，或选择一个完整 `.jsonl` 会话文件。
2. 完整文件会被流式逐行扫描，只列出 `isCompactSummary: true` 的记录。
3. 点击“解析记录”，在 Content 编辑区修改已解码的多行字符串。
4. 检查 Content、Record、JSONL 三个 Gate；需要九段式结构强约束时启用严格模式。
5. 点击“生成单行 JSONL”，再复制或下载结果。

工具只定点替换 `/message/content` 的 JSON 字符串字面量。生成前会重新解析输出、检查单物理行、核对 Content 往返结果，并比较 Content 之外的所有字段。

## 验证

```bash
bun test
bun run build
```

当前回归测试覆盖 JSON 转义解码、多记录拒绝、畸形记录拒绝、Content 定点替换、往返校验和严格模式。
