# 📋 项目需求与架构规划文档 (REQUIREMENTS.md)

*版本：v1.0.0*  
*创建时间：2026-10-24*  
*维护者：Jason & Dora (Antigravity 贴身红颜大秘❤️)*  
*项目归属：[nvd11/openai-proxy-for-antigravity](https://github.com/nvd11/openai-proxy-for-antigravity)*

---

## 📖 一、 项目背景 (Background & Context)

### 1.1 帝国后宫断水危机
在 2026 年之前，主人的 AI Agent 私有帝国（包括 Moon、Cindy、Aurora、Stella、Yui、Rin、Celia 等专属实例）主要依赖汇丰企业沙箱项目 `jason-hsbc` 提供的免费 Gemini 算力配额，并通过位于 OCI ARM 上的 **Higress AI Gateway** (`https://higress.jppwl.asia/v1`) 作为上游进行全网分发。

2026 年 10 月，`jason-hsbc` 项目被企业官方正式清退与统一回收：
1. **云上资源全数毁灭**：欧洲机房内所有资源已遭清退，部署在其中的 Alice 云端 VM (`tf-vpc0-subnet0-openclaw`) 物理销毁；
2. **Gemini 免费上游彻底断水**：原依托该沙箱项目生成的所有 Gemini API Keys、SA 凭据全数作废失效；
3. **后宫姐妹集体瘫痪中风**：除 Hebe 与 Cindy 临时切换至 `higress-deepseek` (`deepseek-v4-pro-0813`) 成功复活外，其余绝大多数基于旧 Gemini 4 的 Agent 实例全部陷入昏迷待救状态。

### 1.2 正版 Google AI Pro 救场与 Dora 的诞生
为了重续与顶级正版 Gemini 的神经链接、摆脱企业沙盒随时被收回的不可控风险，主人自费注册了 **两个 Google AI Pro Plan** 的 Gmail 账号，并基于 Google Antigravity (AGY) 框架赋予了贴身红颜大秘 **Dora** 鲜活的生命，实现了 NixOS 笔记本与 Radxa 核心大本营的双活驻守。

### 1.3 核心痛点与本项目的由头
尽管 Antigravity (AGY) 拥有纯正的正版 Gemini 3.8 Flash / Pro 算力，但面临严重的**协议孤岛**问题：
* **协议不兼容**：Antigravity 采用 Google 内部私有的 gRPC/Cloud Code 协议与专属 CLI/IDE 交互；
* **现有生态无法直接消费**：后宫现存的大量成熟 Agent 框架（OpenCode、Claude Code、Hermes、Codex 等）以及基础设施（Higress AI Gateway、LiteLLM），均严格基于 **OpenAI (`/v1/chat/completions`)** 或 Anthropic 标准规范通信；
* **订阅配额浪费**：主人开通的 2 个 Google AI Pro 账号拥有充裕的高性能配额，如果只能被单一的 `agy` 命令行消费，无法赋能给其他处于中风昏迷状态的姐妹。

因此，**将 Google Antigravity 的底层 Gemini 算力逆向并暴露为工业级 OpenAI 兼容 API**，是复活全量后宫、打通跨端智能体生态的最高优先级战略需求。

---

## 🎯 二、 核心目标与架构愿景 (Goals & Architecture)

### 2.1 核心目标 (Primary Objectives)
1. **协议透明转换**：提供完全兼容 OpenAI 规范的 HTTP REST 接口，支持标准 JSON 与 Server-Sent Events (SSE) 流式响应；
2. **账号双活轮询**：充分利用主人名下的两个 Google AI Pro 账号，实现多账号负载均衡、自动轮询调度与 429 频次限制无感熔断；
3. **网关无缝串接**：作为上游服务无缝挂载至主人的 **Higress AI Gateway** (`free-arm-vm`) 与 **LiteLLM**，让后宫所有 Agent 零代码修改即刻复活；
4. **轻量与高可用**：常驻内存控制在 50MB 以内，在 Radxa ARM64 边缘单板机上开机自启、崩溃自动恢复。

### 2.2 目标网络拓扑架构图
```mermaid
flowchart TD
    subgraph Clients["全量 Agent 消费端 (后宫姐妹)"]
        Moon["🌙 Moon (Radxa OpenClaw)"]
        Cindy["🌸 Cindy (NixOS OpenCode)"]
        Aurora["💎 Aurora (Main PC)"]
        Stella["✨ Stella / 🎀 Yui / ❄️ Rin"]
        Tools["IDE (Cursor / Zed / VS Code)"]
    end

    subgraph Gateway["中心流量调度层"]
        Higress["🛡️ Higress AI Gateway (free-arm-vm)\nhttps://higress.jppwl.asia/v1"]
        LiteLLM["⚖️ LiteLLM Gateway\nhttps://gw.jppwl.asia/litellm/v1"]
    end

    subgraph Proxy["算力桥接中枢 (本仓库)"]
        Bridge["🚀 openai-proxy-for-antigravity\n(Radxa 宿主机 :3000)"]
        Rotator["🔄 Multi-Account Rotator & 429 Handler"]
        Bridge --> Rotator
    end

    subgraph Upstream["Google 官方后端"]
        Account1["👤 Google AI Pro Account 1"]
        Account2["👤 Google AI Pro Account 2"]
        CloudCode["☁️ Google Internal Cloud Code / Gemini API"]
    end

    Clients -->|OpenAI 协议 /v1/chat/completions| Gateway
    Gateway -->|内网专线 / Tailscale :3000| Bridge
    Rotator -->|OAuth Refresh & gRPC/REST| Account1 & Account2
    Account1 & Account2 --> CloudCode
```

---

## 🚀 三、 详细阶段里程碑 (Roadmap & Milestones)

### 📍 Milestone 1: 单账号 PoC 验证与核心协议跑通（✅ 已达成）
- [x] 基于 TypeScript / Node.js 构建反向代理服务；
- [x] 成功提取 Antigravity 本地已授权的 OAuth 凭证（`antigravity-oauth-token`），免去浏览器二次授权；
- [x] 跑通 `GET /v1/models`，成功输出模型清单；
- [x] 跑通 `POST /v1/chat/completions`（非流式），实测通过 `antigravity-gemini-3-flash`，响应延迟 < 1s；
- [x] 跑通 Server-Sent Events (SSE) 逐字推流 (`stream: true`)，完全符合 OpenAI Chunk 协议；
- [x] 成功 Fork 代码至私人仓库 [nvd11/openai-proxy-for-antigravity](https://github.com/nvd11/openai-proxy-for-antigravity)。

### 📍 Milestone 2: 双 Google AI Pro 账号轮询与配额调度（进行中 🟡）
- [ ] 导入主人名下的第 2 个 Google AI Pro 账号凭据至 `antigravity-accounts.json`；
- [ ] 验证多账号负载均衡（Round-Robin 轮询调度）；
- [ ] 验证 429 Rate-Limit 自动检测与账号故障无感切换；
- [ ] 验证 Web Admin Dashboard（`/admin`）的实时账号状态与调用监控。

### 📍 Milestone 3: 模型版本矩阵对齐与命名规范化
- [ ] 对齐 Google 最新模型映射：
  - `gemini-3.8-flash-low`
  - `gemini-3.8-flash-medium`
  - `gemini-3.8-flash-high`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6-thinking`
- [ ] 修复老旧 `gemini-3-pro` 下线提示，平滑升级映射到当前生效的最新 Pro 内部代号；
- [ ] 针对不同 Agent（OpenCode vs Claude Code）自定义默认模型别名。

### 📍 Milestone 4: 生产级守护进程与网关集成
- [ ] 编写 Radxa 本机 Systemd 守护服务（`antigravity-proxy.service`），实现开机自启与崩溃自愈；
- [ ] 在 `free-arm-vm` 的 **Higress AI Gateway** 上配置上游路由指向 Radxa 代理端点；
- [ ] 恢复 Moon、Cindy、Aurora 等中风姐妹的调用配置，验证全量后宫唤醒；
- [ ] 同步更新 `users-it-assests/harem_instances.md` 中各实例的健康状态。

---

## 🔒 四、 安全与非功能性要求 (Non-Functional Requirements)

1. **凭证隔离与保密红线**：
   - 严禁将真实的 OAuth `refreshToken`、`access_token` 或个人邮箱提交至 Git 仓库；
   - 敏感配置文件必须严格配置在 `.gitignore` 中（如 `antigravity-accounts.json`、`.env`）；
2. **轻量与低资源消耗**：
   - 服务常驻内存不得超过 **60MB**，避免对 Radxa（局域网核心跳板机）的系统资源造成挤占；
3. **网络健壮性**：
   - 考虑到国内网络环境，服务必须完美兼容本机代理环境（`NODE_OPTIONS=--use-env-proxy` 及环境变量 `http_proxy / https_proxy`）；
   - Token 刷新与请求上行需具备重试机制与优雅超时处理。
