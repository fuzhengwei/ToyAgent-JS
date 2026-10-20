import { ChatModel } from './chat-model.js';

/**
 * 教学演示用 Mock 模型：不联网、不花钱，让 26 个场景开箱即跑。
 *
 * 它并非"真智能"，而是按场景预设了符合协议的返回（例如工具调用时
 * 返回 JSON 决策、ReAct 时返回 Thought/Action），让学习者可以完整
 * 观察智能体的「骨架」如何运转。配置真实 API Key 后骨架不变，
 * 换上真大脑即可。
 *
 * 与 Java 版 MockChatModel 逐场景 1:1 对应：正则、关键词、返回文案一致。
 */
export class MockChatModel extends ChatModel {

    constructor(scenario) {
        super();
        this.scenario = scenario;
    }

    async chat(messages) {
        const system = messages[0].content;
        const last = lastUserText(messages);
        const all = messages.reduce((a, m) => a + '\n' + m.content, '');

        switch (this.scenario) {
            case 'step01': return mockChat(last);
            case 'step02': return mockPrompt(last, system);
            case 'step03': return mockReAct(all, last);
            case 'step04': return mockToolCall(last);
            case 'step05': return mockMemory(all, last);
            case 'step06': return mockRouter(last);
            case 'step09': return mockMcp(last);
            case 'step10': return mockSkill(all, last);
            case 'step07': return mockRag(all, last);
            case 'step12': return mockMulti(all, system);
            case 'step15': return mockLoop(last, all);
            case 'step16': return mockWorkflow(all, last);
            case 'step18': return mockFull(all, last);
            case 'step11': return mockRegistry(last);
            case 'step17': return mockRuntime(all, last);
            case 'step19': return mockAsk(all, last);
            case 'step20': return mockApproval(last);
            case 'step21': return mockSandbox(last);
            case 'step22': return mockEvent(all, last);
            case 'step23': return mockPlugin(all, last);
            case 'step25': return mockCli(all, last, system);
            case 'step13': return mockSubagent(all, last, system);
            case 'step24': return mockHooks(all, last, system);
            case 'step14': return mockA2a(all, last, system);
            case 'step26': return mockSchedule(all, last, system);
            default: return '（Mock 模型）收到：' + last;
        }
    }
}

function lastUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return messages[i].content;
    }
    return '';
}

// ------------------------------------------------------------- step01 对话

function mockChat(input) {
    if (input.includes('你好') || input.includes('hi') || input.includes('hello')) {
        return '你好！我是 ToyAgent 里的最小智能体。我的全部实现只有一个方法：chat(input)。输入进来，模型处理，回答出去 —— 这就是智能体的最小 MVP。';
    }
    return '（Mock 模型）已收到你的消息：「' + clip(input) + '」。\n'
        + 'Step01 的实现没有策略、没有工具、没有记忆 —— 每次对话都是一次独立的「输入 → 模型 → 输出」。\n'
        + '配置真实 API Key 后，这句回复将由真实大模型生成。继续试试右边的示例问题吧。';
}

// ------------------------------------------------------------- step02 提示词

function mockPrompt(input, system) {
    const oneLine = input.includes('一句话');
    if (oneLine) {
        return '好的，遵守「一句话」约束：智能体就是一个用大模型做决策、用工具做执行的程序。';
    }
    return '好的，我是你的技术助理（角色由系统提示词设定）。「' + clip(input) + '」可以这样理解：\n\n'
        + '1. 定义 —— 智能体 = 大模型(大脑) + 工具(手脚) + 循环(节拍)。\n'
        + '2. 原理 —— 模型根据系统提示词中的人设与约束来组织回答，本条回复就是模板化输出的效果。\n'
        + '3. 建议 —— 好提示词 = 明确角色 + 交代背景 + 给出任务与约束，这正是 Step02 代码里 systemPrompt 的三层结构。\n\n'
        + '（Mock 模型按系统提示词的格式约定作答；真实模型会表现出同样的角色倾向。）';
}

// ------------------------------------------------------------- step18 全流程

/** 与 step03 同一套 ReAct JSON 协议，但画像信息会让回答更「有记忆」。 */
function mockFull(all, last) {
    let portrait = '';
    if (all.includes('名字={')) {
        portrait = '，' + extractAfter(all, '名字={').replace(/\}.*/, '') + '同学';
    } else if (all.includes('喜好={')) {
        portrait = '，还记得你喜欢' + extractAfter(all, '喜好={').replace(/\}.*/, '');
    }
    if (all.includes('Observation:')) {
        const obs = extractAfter(all, 'Observation:');
        return JSON.stringify({
            thought: '工具结果已返回，结合记忆与观察结果组织最终回答',
            final: clip(obs) + ' —— 本轮完整走过了：守卫 → 记忆 → 循环 → 工具 → 输出校验 → 回写记忆'
                + (portrait === '' ? '。' : '（' + portrait.replace('，', '') + '）。'),
        });
    }
    if (/\d+\s*[+\-*/]\s*\d+/.test(last)) {
        const m = last.match(/\d+\s*[+\-*/]\s*\d+/);
        const expr = m ? m[0] : '1+1';
        return JSON.stringify({
            thought: '有算式，调用计算器工具，不能靠心算',
            action: 'calculator',
            action_input: expr,
        });
    }
    const city = findCity(last);
    if (city !== '北京' || last.includes('天气')) {
        return JSON.stringify({
            thought: '问题需要实时数据，先调天气工具',
            action: 'get_weather',
            action_input: city,
        });
    }
    return JSON.stringify({
        thought: '普通寒暄无需工具，直接结合记忆回答',
        final: '你好' + (portrait === '' ? '！' : portrait + '！')
            + '我是全流程智能体：守卫已放行你的输入，记忆里' + (portrait === '' ? '还没有你的档案' : '有你的画像')
            + '，本轮无需调用工具即可作答。',
    });
}

// ------------------------------------------------------------- step03 ReAct

function mockReAct(all, last) {
    if (all.includes('Observation:')) {
        const obs = extractAfter(all, 'Observation:');
        return JSON.stringify({
            thought: '已拿到工具观察结果，可以回答用户了',
            final: '根据工具查询结果：' + clip(obs) + ' —— 这就是 ReAct：先想（Thought）、再做（Action）、看结果（Observation），直到能给出最终答案（Final Answer）。',
        });
    }
    if (/\d+\s*[+\-*/]\s*\d+/.test(last)) {
        const m = last.match(/\d+\s*[+\-*/]\s*\d+/);
        const expr = m ? m[0] : '1+1';
        return JSON.stringify({
            thought: '这是一个算式，我不能心算，应该调用计算器工具保证准确',
            action: 'calculator',
            action_input: expr,
        });
    }
    const city = findCity(last);
    return JSON.stringify({
        thought: '用户询问了天气相关的问题，我需要先调用天气工具获取实时数据',
        action: 'get_weather',
        action_input: city,
    });
}

// ------------------------------------------------------------- step04 工具调用

function mockToolCall(last) {
    // 工具结果回填轮：不再发起调用，基于事实生成回答
    if (last.includes('执行结果') || last.includes('Observation')) {
        const fact = extractAfter(last, '执行结果');
        return '根据工具返回的结果：' + (fact.trim() === '' ? clip(last) : clip(fact)) + '，这就是你要的答案 —— 工具调用链闭环完成。';
    }
    if (last.includes('天气') || last.includes('weather')) {
        return JSON.stringify({
            tool: 'get_weather',
            arguments: { city: findCity(last) },
        });
    }
    const m = last.match(/\d+\s*[+\-*/]\s*\d+/);
    if (m) {
        return JSON.stringify({
            tool: 'calculator',
            arguments: { expression: m[0] },
        });
    }
    return '这个问题不需要调用工具，我直接回答：「' + clip(last) + '」—— 工具调用的关键在于：模型自己判断「要不要用工具、用哪个、参数是什么」。';
}

// ------------------------------------------------------------- step05 记忆

function mockMemory(all, last) {
    // 从完整对话历史里找"我叫X"，真实体现"记忆 = 把历史放进上下文"
    // 修正：排除「我叫什么/名字/谁/啥」疑问句（与 step22 mockEvent 的排除式一致，
    // 否则「我叫什么」会被误当作用户自报姓名）
    const re = /我叫([\u4e00-\u9fa5A-Za-z0-9]{1,10})/g;
    let remembered = null;
    for (const m of all.matchAll(re)) {
        const n = m[1];
        if (n.startsWith('什么') || n.startsWith('名字') || n.startsWith('谁') || n.startsWith('啥')) continue;
        remembered = n;
    }

    if (last.includes('我叫') && !/我叫(?:什么|名字|谁|啥)/.test(last)) {
        return '你好，' + remembered + '！我已把你的名字放进对话历史（注意看右侧的「记忆窗口」计数）。';
    }
    if (last.includes('叫什么') || last.includes('记得') || last.includes('谁')) {
        return remembered != null
            ? '当然记得，你叫「' + remembered + '」。我没有数据库 —— 是因为之前那轮对话还在上下文窗口里，这就是短期记忆的全部秘密。'
            : '目前的历史里还没有你的名字，先告诉我「我叫XX」吧。';
    }
    if (last.includes('压缩') || last.includes('总结')) {
        return '已对历史对话做了压缩摘要：保留关键事实（如你的名字、讨论主题），丢弃寒暄与重复内容 —— 滑窗 + 摘要，就是上下文工程最常用的两板斧。';
    }
    return '（Mock 模型）这一轮我带着 ' + countHistory(all) + ' 条历史消息在工作。多轮对话 = 每次都把「系统提示词 + 全部历史 + 新输入」发给模型。';
}

function countHistory(all) {
    return all.split('\n').filter(l => l.trim() !== '').length;
}

// ------------------------------------------------------------- step06 路由

function mockRouter(last) {
    let intent;
    if (last.includes('天气') || last.includes('weather')) intent = 'weather';
    else if (/\d+\s*[+\-*/]\s*\d+/.test(last)) intent = 'math';
    else intent = 'chat';
    return JSON.stringify({
        intent,
        reason: '根据用户输入关键词与语义判断下一步走向',
    });
}

// ------------------------------------------------------------- step09 MCP

function mockMcp(last) {
    // 工具结果回填轮：不再发起调用
    if (last.includes('工具结果') || last.includes('Observation')) {
        const fact = extractAfter(last, '工具结果');
        return '基于 MCP Server 返回的事实：' + (fact.trim() === '' ? clip(last) : clip(fact)) + ' —— 标准协议下的调用链闭环完成。';
    }
    if (last.includes('天气') || last.includes('weather')) {
        return JSON.stringify({
            method: 'tools/call',
            params: { name: 'get_weather', arguments: { city: findCity(last) } },
        });
    }
    return '（Mock 模型）MCP 的核心是把「工具」标准化：统一注册、统一发现（tools/list）、统一调用（tools/call）。这个问题我直接回答即可，无需调用工具。';
}

// ------------------------------------------------------------- step10 技能

function mockSkill(all, last) {
    // 技能执行轮：travel_plan 技能内的模型调用按角色作答
    if (all.includes('旅行顾问')) {
        return '杭州出行攻略：① 当前晴，27℃，适宜户外；② 建议上午游西湖，下午避晒逛馆；③ 早晚温差小，轻装出行即可。（由 L1 技能组合天气与时间工具产出）';
    }
    let skill;
    if (last.includes('旅行') || last.includes('攻略') || last.includes('旅游')) skill = 'travel_plan';
    else if (last.includes('天气')) skill = 'weather_report';
    else skill = 'free_chat';
    return JSON.stringify({
        skill,
        reason: '依据输入语义匹配已注册技能',
    });
}

// ------------------------------------------------------------- step07 RAG

function mockRag(all, last) {
    const ctx = extractAfter(all, '【参考资料】');
    if (ctx.trim() !== '') {
        const firstLine = ctx.split('\n').find(l => true) ?? '相关资料';
        return '根据检索到的资料：「' + clip(firstLine) + '」……\n\n'
            + '回答基于知识库片段 [1][2] 生成 —— 模型只负责「戴着资料说话」，事实由检索保证，这就是 RAG 解决模型幻觉与知识过期的思路。';
    }
    return '（Mock 模型）知识库中未命中相关片段时，我会如实回答不知道，而不是编造 —— 拒答也是 RAG 的重要能力。';
}

// ------------------------------------------------------------- step12 多智能体

function mockMulti(all, system) {
    if (system.includes('规划者')) {
        return JSON.stringify({
            plan: [
                { role: '研究员', task: '围绕主题收集要点' },
                { role: '写手', task: '把要点组织成一篇短文' },
                { role: '审查员', task: '检查事实与结构，不通过则打回' },
            ],
        });
    }
    if (system.includes('研究员')) {
        return '研究笔记：① 智能体的本质是模型驱动的循环；② 工具扩展了模型的行动边界；③ 工程化决定上限。';
    }
    if (system.includes('审查员')) {
        return JSON.stringify({ pass: true, comment: '结构完整、表述准确，建议保留要点式风格' });
    }
    if (all.includes('研究笔记')) {
        return '短文：智能体并不神秘 —— 它是一个让大模型「边想边做」的循环程序：模型负责决策，工具负责执行，记忆负责延续，工程负责兜底。（由写手智能体基于研究笔记产出）';
    }
    return '（Mock 模型）已收到任务。';
}

// ------------------------------------------------------------- step15 Loop + 守卫

function mockLoop(last, all) {
    if (all.includes('Observation:')) {
        const obs = extractAfter(all, 'Observation:');
        return JSON.stringify({
            thought: '信息足够，输出最终答案',
            final: '循环结束，最终回答：' + clip(obs),
        });
    }
    return JSON.stringify({
        thought: '进入运行时循环，先获取所需信息',
        action: 'get_weather',
        action_input: findCity(last),
    });
}

// ------------------------------------------------------------- step16 工作流

function mockWorkflow(all, last) {
    if (all.includes('[节点:classify]')) {
        const next = last.includes('天气') || /\d+\s*[+\-*/]/.test(last) ? 'tool' : 'faq';
        return JSON.stringify({ next, reason: '意图分类节点给出路由' });
    }
    if (all.includes('[节点:tool]')) {
        if (/\d+\s*[+\-*/]\s*\d+/.test(last)) {
            const m = last.match(/\d+\s*[+\-*/]\s*\d+/);
            return JSON.stringify({ tool: 'calculator', arguments: { expression: m ? m[0] : '1+1' } });
        }
        return JSON.stringify({ tool: 'get_weather', arguments: { city: findCity(last) } });
    }
    if (all.includes('Observation:')) {
        return '综合以上节点结果，这里是最终回答：' + clip(extractAfter(all, 'Observation:')) + '（由 polish 节点整理输出）。';
    }
    if (all.includes('[节点:polish]')) {
        const base = (extractAfter(all, '前序产出: ').split('\n').find(l => true) ?? '');
        return base.trim() === '' ? '润色完成：「' + clip(last) + '」。' : '润色完成：' + clip(base);
    }
    return '这是 FAQ 节点的直接回答。「' + clip(last) + '」属于常见问题，无需工具，命中预设答案后进入 polish 润色。';
}

// ------------------------------------------------------------- step11 工具注册表

/** 与 step04 同一套 {"tool","arguments"} 协议，但工具清单来自注册表。 */
function mockRegistry(last) {
    if (last.includes('执行结果')) {
        const fact = extractAfter(last, '执行结果');
        return '根据工具返回的结果：' + (fact.trim() === '' ? clip(last) : clip(fact)) + ' —— 执行器全程只查注册表，不认识任何具体工具。';
    }
    if (last.includes('天气') || last.includes('weather')) {
        return JSON.stringify({ tool: 'get_weather', arguments: { city: findCity(last) } });
    }
    const m = last.match(/\d+\s*[+\-*/]\s*\d+/);
    if (m) {
        return JSON.stringify({ tool: 'calculator', arguments: { expression: m[0] } });
    }
    if (last.includes('几点') || last.includes('时间')) {
        return JSON.stringify({ tool: 'get_time', arguments: {} });
    }
    return '这个问题不需要调用工具，直接回答即可 —— 工具清单由注册表动态生成，注册即生效、注销即消失。';
}

// ------------------------------------------------------------- step17 ReAct 运行时

/** ReAct 协议；「死循环测试」会永远发起 echo 工具调用，触发 MAX_STEPS 保险丝。 */
function mockRuntime(all, last) {
    // echo 的观察结果继续发起 echo —— 模拟失控场景，直到保险丝起跳
    if (last.startsWith('Observation: echo:')) {
        return JSON.stringify({
            thought: '任务还没完成，继续调用 echo（模拟失控）',
            action: 'echo',
            action_input: 'tick',
        });
    }
    if (last.includes('死循环') || last.includes('循环测试')) {
        return JSON.stringify({
            thought: '这个任务永远做不完（模拟失控场景）',
            action: 'echo',
            action_input: 'tick',
        });
    }
    if (all.includes('Observation:')) {
        const obs = extractAfter(all, 'Observation:');
        return JSON.stringify({
            thought: '已拿到观察结果，信息足够，结束本回合',
            final: '根据工具查询结果：' + clip(obs) + '（turn 以 TurnEndReason.Completed 收场）',
        });
    }
    const m = last.match(/\d+\s*[+\-*/]\s*\d+/);
    if (m) {
        return JSON.stringify({
            thought: '有算式，调用计算器，不能心算',
            action: 'calculator',
            action_input: m[0],
        });
    }
    if (last.includes('天气') || last.includes('weather')) {
        return JSON.stringify({
            thought: '需要实时数据，先调天气工具',
            action: 'get_weather',
            action_input: findCity(last),
        });
    }
    return JSON.stringify({
        thought: '普通对话无需工具，直接作答',
        final: '（Mock 模型）本轮 ' + countHistory(all) + ' 条历史的上下文已按预算裁剪后发给模型。多聊几轮，可在轨迹里看到「上下文裁剪」事件。',
    });
}

// ------------------------------------------------------------- step19 人工介入

/** 缺关键信息时发起 ask_user_question；「人工答复：」回填后带着完整信息完成任务。 */
function mockAsk(all, last) {
    if (all.includes('人工答复：')) {
        const ans = extractAfter(all, '人工答复：').split('\n').find(l => true) ?? '上海';
        const from = ans.includes('上海') ? '上海' : ans.includes('杭州') ? '杭州' : ans.includes('广州') ? '广州' : clip(ans);
        return JSON.stringify({
            final: '已为你预订：' + from + ' → 北京，明日 08:30 起飞，经济舱 ¥1,280（模拟出票）。'
                + '刚才缺出发地时我没有瞎猜，而是问了人 —— 这就是 ask_user_question 的人机协同闭环。',
        });
    }
    if (last.includes('机票') || last.includes('订') || last.includes('出行')) {
        return JSON.stringify({
            ask: '预订机票需要确认出发地 —— 请问从哪个城市出发？（可选：北京 / 上海 / 杭州 / 广州）',
        });
    }
    return JSON.stringify({
        final: '（Mock 模型）信息完整的问题我直接回答。想看人工介入：发「帮我订一张去北京的机票」，我会停下来向你确认出发地。',
    });
}

// ------------------------------------------------------------- step20 审批门禁

function mockApproval(last) {
    if (last.includes('执行结果') || last.includes('审批结果')) {
        return JSON.stringify({
            final: '任务完成：' + clip(last) + ' —— 注意轨迹里的权限矩阵：安全工具自动放行，'
                + '高危工具必须过审批门禁，这是生产级智能体与玩具的分水岭。',
        });
    }
    if (last.includes('邮件') || last.includes('发送') || last.includes('发一封')) {
        return JSON.stringify({
            tool: 'send_email',
            arguments: 'to=team@xiaofuge.cn, content=本周周报',
        });
    }
    if (last.includes('删除') || last.includes('清理')) {
        return JSON.stringify({
            tool: 'delete_file',
            arguments: 'path=workspace/tmp/old.log',
        });
    }
    if (last.includes('天气')) {
        return JSON.stringify({ tool: 'get_weather', arguments: 'city=' + findCity(last) });
    }
    return JSON.stringify({
        final: '（Mock 模型）想看审批门禁：发「给团队发一封周报邮件」（高危，会请求审批），'
            + '回复「批准 / 拒绝 / 批准并记住」观察三种走向。',
    });
}

// ------------------------------------------------------------- step21 沙箱

function mockSandbox(last) {
    if (last.includes('执行结果') || last.includes('已拦截') || last.includes('沙箱内')) {
        return JSON.stringify({ final: clip(last) });
    }
    return JSON.stringify({
        final: '（Mock 模型）沙箱采用纵深防御：策略 → 黑名单 → 边界 → 规范化四层拦截。'
            + '发「执行：ls sandbox」看放行，或「执行：rm -rf /」看第 2 层拦截。',
    });
}

// ------------------------------------------------------------- step22 事件溯源

function mockEvent(all, last) {
    const re = /我叫([\u4e00-\u9fa5A-Za-z0-9]{1,10})/g;
    let remembered = null;
    for (const m of all.matchAll(re)) {
        const n = m[1];
        if (n.startsWith('什么') || n.startsWith('名字') || n.startsWith('谁')) continue;
        remembered = n;
    }
    if (last.includes('我叫')) {
        return JSON.stringify({
            final: '你好，' + remembered + '！这次对话连同你的名字已作为事件写入 JSONL 日志 ——'
                + '我的记忆不是内存变量，而是从日志投影出来的视图，服务重启也不丢。',
        });
    }
    if (last.includes('叫什么') || last.includes('记得')) {
        return remembered != null
            ? JSON.stringify({ final: '你叫「' + remembered + '」。这条记忆是我刚才从事件日志回放重建的 —— 状态即日志。' })
            : JSON.stringify({ final: '日志里还没有你的名字，先说「我叫XX」吧。' });
    }
    return JSON.stringify({
        final: '（Mock 模型）本轮会话由事件日志回放重建。多聊几轮再看 events/step22-events.jsonl，'
            + '每一条对话都是不可变事件；「重置」删掉日志，记忆归零。',
    });
}

// ------------------------------------------------------------- step23 插件机制

/** 插件机制剧本：安装后正常决策调用插件工具；未安装/已卸载时由注册表未命中路径兜底。 */
function mockPlugin(all, last) {
    if (last.includes('执行结果')) {
        const fact = extractAfter(last, '执行结果');
        return '根据插件工具返回的结果：' + (fact.trim() === '' ? clip(last) : clip(fact))
            + ' —— 这个工具不在宿主代码里，而是插件经独立 ClassLoader 装进注册表的。';
    }
    if (last.includes('掷') || last.includes('硬币') || last.includes('coin')) {
        return JSON.stringify({ tool: 'coin_flip', arguments: {} });
    }
    if (last.includes('运行') || last.includes('多久') || last.includes('uptime')) {
        return JSON.stringify({ tool: 'uptime', arguments: {} });
    }
    return '（Mock 模型）先「安装插件」，工具才会出现在我的清单里；「卸载插件」后我再也看不见它们 —— 能力即插即拔。';
}

// ------------------------------------------------------------- step25 CLI 智能体

/** CLI 剧本：命令类输入返回 run_command 决策；其余兜底引导。 */
function mockCli(all, last, system) {
    if (last.includes('执行结果')) {
        const fact = extractAfter(last, '执行结果');
        return '命令结果：' + (fact.trim() === '' ? clip(last) : clip(fact))
            + ' —— run_command 在受限工作区执行，Step21 的四层防御全程护航。';
    }
    if (last.includes('列出') || last.includes('文件') || last.includes('目录') || last.includes('ls')) {
        return JSON.stringify({ tool: 'run_command', arguments: { command: 'ls' } });
    }
    if (last.includes('几点') || last.includes('时间') || last.includes('日期')) {
        return JSON.stringify({ tool: 'run_command', arguments: { command: 'date' } });
    }
    if (last.includes('hello')) {
        return JSON.stringify({ tool: 'run_command', arguments: { command: 'cat hello.txt' } });
    }
    return '我是终端里的 CLI 智能体。试试「运行：ls」，或让我「列出工作区文件」—— 命令都在 sandbox/step25 里执行，危险命令会被四层防御拦截。';
}

// ------------------------------------------------------------- step13 子代理

/** 子代理剧本：system 带【子代理身份】为子代理回合（fork 能看到父会话里的紫色）；否则为主代理回合。 */
function mockSubagent(all, last, system) {
    if (system.includes('子代理身份')) {
        const forkKnows = system.includes('继承的父会话上下文') && system.includes('紫色');
        if (system.includes('写作子代理')) {
            return forkKnows
                ? '愿你的每一天都被喜爱的事物环绕 —— 像那一抹恰到好处的紫色。（fork：我从父会话记得你最喜欢紫色）'
                : '愿你所行皆坦途，所遇皆温暖，往后的每一天都值得期待。（spawn：我只知道任务本身）';
        }
        return 'Agent 调研要点：1) 工具标准化（MCP）成为默认范式；2) 运行时基座（审批/沙箱/事件）走向生产化；3) 多代理协作从固定流水线走向动态派遣。';
    }
    if (last.includes('执行结果')) {
        const fact = extractAfter(last, '执行结果');
        return '子代理已完成任务，结果如下：\n' + (fact.trim() === '' ? clip(last) : fact);
    }
    if (last.includes('fork') || last.includes('继承')) {
        return JSON.stringify({ tool: 'dispatch_subagent', name: 'writer', mode: 'fork', task: '写一句贺词' });
    }
    if (last.includes('spawn') || last.includes('全新')) {
        return JSON.stringify({ tool: 'dispatch_subagent', name: 'writer', mode: 'spawn', task: '写一句贺词' });
    }
    if (last.includes('调研') || last.includes('研究') || last.includes('趋势')) {
        return JSON.stringify({ tool: 'dispatch_subagent', name: 'researcher', mode: 'spawn', task: '调研 Agent 趋势' });
    }
    if (last.includes('记住') || last.includes('最喜欢')) {
        return '好的，已记下。这条信息已进入父会话上下文 —— 之后 fork 出去的子代理都能看到它。';
    }
    if (last.includes('对比')) {
        return '两次贺词的差异就是 spawn 与 fork 的差异：fork 的子代理继承了「最喜欢紫色」，贺词带了紫色；spawn 的子代理是全新实例，只会写通用贺词。';
    }
    return '（Mock 模型）试试：「fork 一个子代理，让它写一句贺词」或「spawn 一个子代理写贺词」，体会两种派遣的上下文差异。';
}

// ------------------------------------------------------------- step24 钩子体系

/** 钩子讲解员：工具调用走宿主直连路由（查询：/发送：/钩子：），模型只负责讲解引导。 */
function mockHooks(all, last, system) {
    if (last.includes('执行结果')) {
        const fact = extractAfter(last, '执行结果');
        return '钩子管线说明：' + (fact.trim() === '' ? clip(last) : clip(fact));
    }
    return JSON.stringify({ final:
        '本场景的钩子挂在工具调用的 before / after 生命周期上。试试：\n'
        + '·「查询：张三」—— after 脱敏钩子把手机号/邮箱打码\n'
        + '·「发送：给 13812345678 发 密码是123456」—— before 风控钩子直接拦截\n'
        + '·「钩子：关」再「查询：张三」—— 摘掉钩子看明文，对比出钩子的价值\n'
        + '·「审计日志」—— before 审计钩子记下的每一次调用' });
}

// ------------------------------------------------------------- step14 A2A 协作

/** A2A 剧本：先发现名片，再按任务类型路由到 translator / weather。 */
function mockA2a(all, last, system) {
    if (last.includes('执行结果')) {
        const fact = extractAfter(last, '执行结果');
        return '外部代理已通过 A2A 回执：' + (fact.trim() === '' ? clip(last) : fact)
            + ' —— 对方有自己的模型与工具，我们只认 task_id 与回执。';
    }
    if (last.includes('发现') || last.includes('名片') || last.includes('附近')) {
        return JSON.stringify({ tool: 'a2a_discover' });
    }
    if (last.includes('翻译')) {
        return JSON.stringify({
            tool: 'a2a_send',
            agent: 'translator',
            task: '把「你好，智能体」翻译成英文',
        });
    }
    if (last.includes('天气') || last.includes('户外')) {
        return JSON.stringify({
            tool: 'a2a_send',
            agent: 'weather',
            task: '明天适合户外运动吗？',
        });
    }
    return JSON.stringify({
        final: '我是主代理，可以经 A2A 协议与外部代理协作。试试：「发现一下附近的代理」，'
            + '或直接「让翻译代理把……翻译成英文」「问问天气代理明天适合户外运动吗」。',
    });
}

// ------------------------------------------------------------- step26 定时工具

/** 定时讲解员：调度走宿主直连路由（定时：/循环：/任务列表/取消：），模型只负责讲解引导。 */
function mockSchedule(all, last, system) {
    if (last.includes('执行结果')) {
        const fact = extractAfter(last, '执行结果');
        return '定时任务说明：' + (fact.trim() === '' ? clip(last) : clip(fact));
    }
    return JSON.stringify({
        final: '本场景给工具装上了时间维度。试试：\n'
            + '·「定时：5秒 提醒我喝水」—— 一次性调度，拿 job_id\n'
            + '·「任务列表」—— 看 pending / 已触发次数\n'
            + '·「循环：每10秒 报一次时」—— 周期任务\n'
            + '·「取消：job-1」「完成了什么」—— 管理与回看（触发结果落盘 events/step26-tasks.jsonl）',
    });
}

// ------------------------------------------------------------- 工具方法

const CITIES = {
    '北京': '晴，26℃', '上海': '多云，28℃', '广州': '雷阵雨，31℃',
    '深圳': '阵雨，30℃', '杭州': '晴，27℃', '成都': '阴，22℃',
};

function findCity(text) {
    for (const city of Object.keys(CITIES)) {
        if (text.includes(city)) return city;
    }
    return '北京';
}

function extractAfter(text, marker) {
    const idx = text.lastIndexOf(marker);
    if (idx < 0) return '';
    return text.substring(idx + marker.length).replace(/^[\s:：]+/, '').trim();
}

function clip(s) {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > 60 ? one.slice(0, 60) + '…' : one;
}
