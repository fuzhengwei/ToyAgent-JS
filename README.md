# ToyAgent-JS

> 用最简单的方式，讲清楚智能体实现 —— **一个类，就是一个智能体的最小 MVP**。

原生 JavaScript (ESM) · Node >= 18 · 零运行时依赖 · 26 个渐进式场景 · CLI 演示运行器（web 版见 Java 工程 [ToyAgent](../ToyAgent)）。配套教程：[AI Agent 通识教程（ai-agent-guide）](../README.md)。

## 一句话读懂

智能体的灵魂只有一个方法：

```js
const answer = await agent.chat(input);   // 输入一句话，输出一句话
```

26 个场景按七条主题弧线递进：基础内核（1-4）→ 记忆与知识（5-8，含 RAG 与 LLM-Wiki）→ 工具的进化（9-11）→ 协作与派遣（12-14）→ 运行时与工程化（15-18，第 18 个全流程综合）→ 人机协同与安全（19-22）→ 扩展与形态（23-26）。第 15-22 个参考 deepseek-harness-java，第 23-26 个补齐插件 / 钩子 / CLI / 定时生态。

## 26 个场景

| # | 场景 | 类 | 新增能力 | 对应教程章节 |
|:---:|------|--------|----------|:---:|
| 01 | 对话智能体 | `ChatAgent` | 最小 MVP：接通模型 | ch01-03 |
| 02 | 提示词工程 | `PromptAgent` | 系统提示词三层结构 | ch04 |
| 03 | ReAct 循环 | `ReActAgent` | 思考-行动-观察 | ch04b/05 |
| 04 | 工具调用 | `ToolCallAgent` | Function Calling | ch03/10 |
| 05 | 记忆系统 | `MemoryAgent` | 多轮记忆 + 上下文压缩 | ch06 |
| 06 | 意图路由 | `RouterAgent` | 意图识别 + 决策中枢 | ch06b/07 |
| 09 | MCP 协议 | `McpAgent` | 工具标准化接口 | ch07b/11 |
| 10 | 技能编排 | `SkillAgent` | Skills L0/L1/L2 | ch08/12 |
| 07 | RAG | `RagAgent` | 检索增强生成 | ch16/20 |
| 12 | 多智能体 | `MultiAgent` | 规划-执行-审查协作 | ch10/14 |
| 15 | Loop 运行时 | `LoopAgent` | 守卫 + 保险丝 + 兜底 | ch08b/18/21 |
| 16 | 工作流状态机 | `WorkflowAgent` | LangGraph 思想编排 | ch11b/15 |
| 18 | 全流程智能体 | `FullAgent` | 守卫+记忆+ReAct+工具+保险丝 综合链路 | 综合 Step01-17 |
| 08 | LLM-Wiki 知识编译 | `WikiAgent` | 知识编译一次、持久维护、增量沉淀 | ch13/26 |
| 11 | 工具注册表 | `RegistryAgent` | ToolDefinition 协议：注册/发现/热注销（disposer） | dsh-java |
| 17 | ReAct 运行时 | `RuntimeAgent` | turn/step 两级循环 + 上下文裁剪 + TurnEndReason | dsh-java |
| 19 | 人工介入 | `AskAgent` | ask_user_question：提问挂起 → 人工答复续跑 | dsh-java |
| 20 | 审批门禁 | `ApprovalAgent` | 风险分级 + 审批挂起 + 会话免审 + 超时默认 DENY | dsh-java |
| 21 | 沙箱纵深防御 | `SandboxAgent` | 策略/黑名单/边界/规范化 四层拦截 | dsh-java |
| 22 | 事件溯源 | `EventSourcedAgent` | JSONL 事件流 append-only + 回放投影重建状态 | dsh-java |
| 23 | 插件机制 | `PluginAgent` | AgentPlugin 契约 + 隔离动态加载 + 工具桥接批量注册/注销 | dsh-java |
| 25 | CLI 智能体 | `CliAgent` | 终端 REPL + 沙箱 shell 执行器（复用 Step21 四层防御） | 教程 ch18 |
| 13 | 子代理 | `SubagentAgent` | dispatch_subagent：spawn 全新上下文 / fork 继承父会话，主代理动态派遣 | dsh-java |
| 24 | Hooks 钩子 | `HooksAgent` | before 拦截/改写参数 · after 脱敏/审计，挂钩即生效摘钩即消失 | dsh-java |
| 14 | A2A 协作 | `A2AAgent` | Agent Card 名片发现 + task_id 信封 + 异步回执，跨代理标准化协作 | dsh-java |
| 26 | 定时工具 | `ScheduleAgent` | 一次性/循环调度，触发结果 append 到事件日志可回看 | dsh-java |

每个场景一个文件，位于 `src/agents/`，顶部注释即教程。

## 快速开始

零依赖，clone 即跑（Node >= 18）：

```bash
cd ToyAgent-JS

# 帮助 + 场景清单
node src/main.js

# 单轮执行某个场景
node src/main.js run step01 "你好"
node src/main.js run step03 "北京天气怎么样"
node src/main.js run step18 "1+1"

# 交互 REPL：先选场景，再循环对话（/reset 清空状态，/exit 退出）
node src/main.js
```

### 接入真实大模型（可选）

复制配置模板并填入任意 OpenAI 兼容 API（DeepSeek / 通义 / 智谱 / 火山方舟…）：

```properties
# config.properties
base-url=https://api.deepseek.com/v1
api-key=sk-xxx
model=deepseek-chat
```

也可用环境变量（优先级：config.properties 非空值 > `LLM_*` > `OPENAI_*` > 内置默认）：

```bash
export LLM_API_KEY=sk-xxx
```

> 未配置 Key 时自动使用内置 **Mock 模型**：不联网、不花钱，所有场景的执行轨迹（ReAct 循环、工具调用、路由决策、RAG 检索…）照常完整展示。配上真实 Key，同一套骨架立刻换上真大脑。

### 冒烟测试

```bash
node test/smoke.mjs   # 覆盖 26 个场景的 Mock 模式验收测试
```

## 项目结构

```
ToyAgent-JS/
├── package.json                         # type: module（纯 ESM，零依赖，无构建步骤）
├── config.properties.example            # 模型配置模板
├── sandbox/step25/hello.txt             # step25 受限工作区预置文件
├── src/
│   ├── main.js                          # CLI 运行器：help / list / run / REPL
│   ├── agent.js                         # 智能体契约：chat(input) / trace() / reset()
│   ├── llm/                             # 模型层
│   │   ├── chat-model.js                # 模型抽象（大脑）
│   │   ├── open-ai-chat-model.js        # OpenAI 兼容协议实现（全局 fetch）
│   │   ├── mock-chat-model.js           # 教学 Mock 模型（26 个场景剧本，与 Java 一致）
│   │   ├── models.js                    # 配置工厂
│   │   └── message.js                   # 对话消息（role + content）
│   └── agents/                          # 26 个场景，一场景一文件
│       ├── step01ChatAgent.js
│       ├── ...
│       └── step26ScheduleAgent.js
└── test/smoke.mjs                       # Mock 模式冒烟测试
```

## 设计理念

1. **一个类 = 一个智能体 MVP** —— 拒绝框架魔法，所有逻辑看得见、摸得着；
2. **零运行时依赖** —— 只用 Node 自带能力（全局 `fetch`、`fs`、`child_process`、`setTimeout`），clone 即跑，无需构建步骤；
3. **由浅入深** —— 26 个场景按七条主题弧线严格递进，每个场景只新增一种能力，文件顶部注释就是教程；
4. **CLI 即测试** —— `run` 单轮执行打印回答 + 轨迹时间线 + 耗时；REPL 支持多轮状态复用（记忆、审批挂起、事件日志）；
5. **Mock/真实双模式** —— 骨架与大脑分离，学习时用 Mock 观察轨迹，进阶时配 Key 换真模型。

## License

Apache-2.0 © 小傅哥
