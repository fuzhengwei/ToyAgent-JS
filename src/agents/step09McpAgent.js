import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { MockWeather, formatTime } from './step03ReActAgent.js';

/**
 * Step09 · MCP 智能体 —— 工具的标准化接口。
 *
 * Step04 的工具是"写死在智能体里"的。MCP（Model Context Protocol）
 * 把工具侧拆成一个独立服务：工具在 Server 中统一注册，Client 通过
 * 两个标准方法使用它们 —— tools/list（发现）与 tools/call（调用）。
 * 从此工具与智能体解耦：换智能体不用重写工具，接新工具不用改智能体。
 *
 * 本场景用几个类模拟这一协议（真实 MCP 是 JSON-RPC over stdio/HTTP）。
 */

/** 工具描述符：MCP 世界里工具的标准"名片"。 */
class ToolDescriptor {
    constructor(name, description, parameters) {
        this.name = name;
        this.description = description;
        this.parameters = parameters;
    }
}

/** MCP Server 接口：工具的标准化宿主（真实实现为独立进程，JSON-RPC 通信）。 */
class McpServer {
    tools() { throw new Error('McpServer 子类必须实现 tools()'); }
    call(toolName, argsJson) { throw new Error('McpServer 子类必须实现 call()'); }
}

/** MCP Client：负责 tools/list 与 tools/call 两个标准方法。 */
class McpClient {
    constructor(server) {
        this.server = server;
    }

    listTools() {
        return this.server.tools().map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        }));
    }

    callTool(name, argsJson) {
        const exists = this.server.tools().some(t => t.name === name);
        if (!exists) return 'MCP 错误: 工具不存在 ' + name;
        return this.server.call(name, argsJson);
    }
}

/** 示例 Server：挂载天气与时间两个工具。 */
class WeatherTimeServer extends McpServer {
    tools() {
        return [
            new ToolDescriptor('get_weather', '查询城市实时天气', 'city'),
            new ToolDescriptor('get_time', '获取当前时间', ''),
        ];
    }

    call(toolName, argsJson) {
        try {
            const args = JSON.parse(argsJson ?? '{}');
            switch (toolName) {
                case 'get_weather': return MockWeather.query(args.city);
                case 'get_time': return formatTime();
                default: return '未知工具';
            }
        } catch (e) {
            return '调用失败: ' + e.message;
        }
    }
}

export class McpAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
        // 一个 MCP Server 挂载两个工具，Client 负责协议交互
        const server = new WeatherTimeServer();
        this.client = new McpClient(server);
    }

    name() {
        return 'Step09 · MCP 协议（工具标准化接口）';
    }

    async chat(input) {
        this.lastTrace = [];

        // 1. 工具发现：从 MCP Server 拉取工具清单，拼进提示词
        const tools = this.client.listTools();
        this.lastTrace.push({
            type: 'mcp',
            label: 'tools/list 工具发现',
            detail: '从 MCP Server 动态获取 ' + tools.length + ' 个工具: ' + tools.map(t => t.name).join(', '),
        });

        let toolDocs = '';
        for (const t of tools) {
            toolDocs += '- ' + t.name + '(' + t.parameters + '): ' + t.description + '\n';
        }

        const decidePrompt = `你是可以调用 MCP 工具的智能体。可用工具：
${toolDocs}
需要工具时只输出 JSON：{"method": "tools/call", "params": {"name": "工具名", "arguments": {"参数": "值"}}}
否则直接自然语言回答。
`;

        // 2. 模型决策
        const raw = (await this.model.chat([Message.system(decidePrompt), Message.user(input)])).trim();
        const decision = tryParse(raw);

        if (decision && typeof decision === 'object' && decision.method === 'tools/call') {
            const params = decision.params ?? {};
            const name = String(params.name);
            const args = JSON.stringify(params.arguments);
            this.lastTrace.push({ type: 'tool', label: 'tools/call 工具调用', detail: name + ' ' + args });

            // 3. 经由 MCP Client 标准化调用
            const result = this.client.callTool(name, args);
            this.lastTrace.push({ type: 'observation', label: 'Server 返回', detail: result });

            const answer = await this.model.chat([
                Message.system('基于工具返回的事实回答，简洁准确。'),
                Message.user(input + '\n工具结果: ' + result),
            ]);
            this.lastTrace.push({ type: 'final', label: '生成回答', detail: '工具与智能体已解耦：Server 换实现，智能体零改动' });
            return answer;
        }

        this.lastTrace.push({ type: 'final', label: '直接回答', detail: '本次无需工具' });
        return raw;
    }

    trace() {
        return [...this.lastTrace];
    }
}

function tryParse(raw) {
    try {
        return JSON.parse(raw.replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim());
    } catch {
        return {};
    }
}
