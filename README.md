# 星伴 AI · StarMate AI

> 本地优先的 AI 聊天、智能体、代码编辑与图片生成工作台。  
> A local-first workspace for AI chat, agents, code editing, and image generation.

[简体中文](./README.zh-CN.md) · [English](./README.en.md) · [文档 / Documentation](./docs/README.md)

## 快速开始 / Quick Start

建议使用 Node.js 22 或更高版本。Node.js 22 or newer is recommended.

```powershell
npm install
npm run dev
```

## 构建 / Build

```powershell
npm run typecheck
npm run build
npm run dist
```

Windows 安装包输出到 `release` 目录。  
The Windows installer is generated in the `release` directory.

## 本地服务 / Local Services

- LM Studio or any OpenAI-compatible local API
- Ollama
- ComfyUI
- Kimi Code（可选：会员 API Key，支持普通版与高速版） / Kimi Code (optional membership API key, Standard and HighSpeed)

项目默认保持模型、会话和文件操作在本机完成；网页搜索仅在任务需要时启用。  
Models, conversations, and file operations remain local by default; web search is used only when required by the task.
