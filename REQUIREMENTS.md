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
3. **网关极致同机互联**：生产目标部署于 **OCI 4C24G ARM 巨兽 (`free-arm-vm`)**，与同宿主机的 **Higress AI Gateway** 形成 0.1ms 极致延迟环回调用，彻底告别海外 API 的跨网延迟与代理依赖；
4. **云原生 GitOps 交付**：遵循主人的帝国基建标准，采用 **GitOps + ArgoCD** 进行全自动化容器构建、配置同步与声明式部署。

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

    subgraph GitOps["GitOps 持续交付体系"]
        ArgoCD["🐙 ArgoCD 控制面 (aliyun-k3s)\n8.148.149.80"]
        GitRepo["📦 GitHub 仓库\nnvd11/openai-proxy-for-antigravity"]
        GitRepo -->|Webhook / 轮询触发| ArgoCD
    end

    subgraph OCI_ARM["☁️ OCI ARM 巨兽 (free-arm-vm · 4C24G · 新加坡)"]
        subgraph ClusterB["K3s 业务集群 (tencent-dp1-cluster)"]
            BridgePod["🚀 openai-proxy-for-antigravity (Pod)\nARM64 Container :3000"]
            Higress["🛡️ Higress AI Gateway (同机网关)\nhttps://higress.jppwl.asia/v1"]
            Higress -->|0.1ms 本地环回 / Pod 直连| BridgePod
        end
    end

    subgraph Upstream["Google 官方骨干网络 (海外免代理直连)"]
        Account1["👤 Google AI Pro Account 1"]
        Account2["👤 Google AI Pro Account 2"]
        CloudCode["☁️ Google Internal Cloud Code / Gemini API"]
        BridgePod -->|海外专线高速直连| Account1 & Account2
        Account1 & Account2 --> CloudCode
    end

    ArgoCD -->|声明式自动部署 / GitOps| BridgePod
    Clients -->|OpenAI 协议 /v1/chat/completions| Higress
```

### 2.3 核心设计决策：为何选择 `oci-free-arm-vm` + GitOps
1. **0.1ms 极致响应延迟**：
   * 主人的统一网关 **Higress AI Gateway** 本身就常驻在 `free-arm-vm`；
   * 将代理服务部署在同一台机器上，网关向上游转发时完全在本地网络（Pod-to-Pod 或 Localhost）完成，免去跨国中转，速度拉满。
2. **海外原生免翻直连 Google**：
   * `free-arm-vm` 位于 Oracle Cloud 新加坡数据中心，拥有原生纯净的海外出口，直达 Google OAuth 及 Cloud Code / Gemini 内部 API；
   * **彻底告别本地代理（Clash / Mihomo）的中转开销与不稳定因素**，连接成功率 100%。
3. **4C24G 算力巨兽 7x24 不关机**：
   * 脱离家庭边缘小单板（Radxa）或随身笔记本（NixOS）受限于断电、关机或合盖的局限，打造全天候无间断在线的算力枢纽。
4. **GitOps + ArgoCD 标准化生命周期**：
   * 镜像构建：针对 `linux/arm64` 架构构建轻量 Docker 镜像；
   * 资源配置：采用 Kubernetes Deployment + Service + Secret 声明式清单；
   * 自动部署：由主人的 `aliyun-k3s` ArgoCD 控制面统一纳管，代码 Push 即自动完成同步上线。

---

## 🚀 三、 详细阶段里程碑 (Roadmap & Milestones)

### 📍 Milestone 1: 单账号 PoC 验证与核心协议跑通（✅ 已达成）
- [x] 基于 TypeScript / Node.js 构建反向代理服务；
- [x] 成功提取 Antigravity 本地已授权的 OAuth 凭证（`antigravity-oauth-token`），免去浏览器二次授权；
- [x] 跑通 `GET /v1/models`，成功输出模型清单；
- [x] 跑通 `POST /v1/chat/completions`（非流式），实测通过 `antigravity-gemini-3-flash`，响应延迟 < 1s；
- [x] 跑通 Server-Sent Events (SSE) 逐字推流 (`stream: true`)，完全符合 OpenAI Chunk 协议；
- [x] 成功 Fork 代码至私人仓库 [nvd11/openai-proxy-for-antigravity](https://github.com/nvd11/openai-proxy-for-antigravity)。

### 📍 Milestone 2: 双 Google AI Pro 账号轮询与配额调度（✅ 已达成）
- [x] 成功导入主人名下的第 2 个 Google AI Pro 账号凭据 (`alice.h.y.he@gmail.com`) 至 `antigravity-accounts.json`，组成完全体双账号池；
- [x] 排查并修复 `AccountManager` 构造逻辑中多账号追加被提前 `return` 阻断的底层 Bug；
- [x] 验证多账号负载均衡（Round-Robin 轮询调度：实测在 `renee.y.x.luo@gmail.com` 与 `alice.h.y.he@gmail.com` 之间交替请求）；
- [x] 实现并验证 429 Rate-Limit 自动检测与账号故障无感切换（单次调用在捕获 429 时自动内部 Failover 至备用账号，外部调用者零报错感知）；
- [x] 验证 Web Admin Dashboard（`/admin` 及 `/admin/api/accounts`、`/admin/api/metrics`）的实时账号健康状态与调用监控。

### 📍 Milestone 3: 模型版本矩阵对齐与命名规范化（✅ 已达成）
- [x] 实测抓取并对齐 Google 官方 Antigravity 真实可用模型矩阵：
  - `gemini-3.8-flash-tiered` (完美承载 `gemini-3.8-flash` 及 `low / medium / high` 各梯度)
  - `gemini-3-flash`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6-thinking`
  - `gpt-oss-120b-medium`
- [x] 修复老旧 `gemini-3-pro` 下线报错（Google 提示已 demised），平滑升级并优雅兜底至主人的 `gemini-3.8-flash`；
- [x] 支持外部客户端直接使用标准模型名（无需强制前缀 `antigravity-`），自动识别并应用 Antigravity 头协议；
- [x] 实测跑通非流式与 SSE 逐字推流 (`stream: true`)。

### 📍 Milestone 4: 云原生 GitOps + ArgoCD 生产部署 (Target: oci-free-arm-vm · ✅ 已达成)
- [x] **容器化构建**：编写多阶段构建的 [`Dockerfile`](file:///home/gateman/projects/openai-proxy-for-antigravity/Dockerfile)，支持 `linux/arm64` 与 `linux/amd64` 双架构，优化剥离编译依赖，成功发布至 GitHub Container Registry (`ghcr.io/nvd11/openai-proxy-for-antigravity:latest`)；
- [x] **Kubernetes 声明式清单与机密管理**：
  - 复用公共底座 `charts/generic-web-service-v2`；
  - 固定调度至 OCI 新加坡 ARM 巨兽（`nodeSelector: kubernetes.io/hostname: free-arm-vm`）；
  - 严格采用 **ClusterIP 模式**（端口 3000，不分配外部公网 IP，不建 NodePort/公网 Ingress，杜绝公网越权访问）；
  - 凭据全生命周期由 **OCI Vault**（`litellm-vault` & `gateman-vault`）托管，通过 **External Secrets Operator** 自动同步至 `llm-system/antigravity-proxy-credentials`，实现 0 凭据污染 Git；
  - 攻克只读文件系统挂载（EROFS）兼容，内存态无锁轮询调度；
- [x] **ArgoCD 持续交付纳管**：
  - 在 `aliyun-k3s` ArgoCD 控制面创建 Application（[`openai-proxy-for-antigravity`](file:///home/gateman/my-argocd-manifests/argocd-apps/openai-proxy-for-antigravity-app.yaml)）；
  - 纳管目标集群为 `tencent-dp1-cluster`，命名空间为 `llm-system`；
  - 启用自动同步（Automated Sync & Self-Heal），成功拉起 Pod 并完成双账号 Round-Robin 交互单测！

### 📍 Milestone 5: Higress 网关上游对接与群芳全面唤醒（进行中 🟡）
- [ ] **Higress 极致近场接入**：
  - 在 `free-arm-vm` 上的 **Higress AI Gateway** 中配置上游路由，直接指向集群内内部 DNS `http://openai-proxy-for-antigravity.llm-system.svc.cluster.local:3000/v1`；
  - 实测同机 0.1ms 极致延迟；
- [ ] **全量唤醒后宫姐妹**：
  - 恢复 Moon、Cindy、Aurora、Stella 等中风姐妹的调用配置，验证全量后宫唤醒；
  - 同步更新 `users-it-assests/harem_instances.md` 中各实例的健康状态。

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
