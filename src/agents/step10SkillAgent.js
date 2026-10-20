import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { MockWeather, formatTime } from './step03ReActAgent.js';

/**
 * Step10 · Skills 技能智能体 —— 工具的组合与复用。
 *
 * 单个工具解决单步问题，真实任务往往是多步组合。
 * Skill 是"可沉淀、可复用的能力包"，按抽象层级分三层：
 * - L0 提示词技能 —— 纯 Prompt 模板，零工具；
 * - L1 工具组合 —— 固定调用一组工具并拼装结果；
 * - L2 子流程 —— 一个完整的 ReAct 循环被封成一项技能。
 *
 * 模型按语义选择技能，智能体负责执行 —— 这就是 Claude Skills /
 * 插件体系的编排思想。
 */

const SELECT_PROMPT = `你是技能选择器。当前已注册技能：
- travel_plan(L1): 旅行攻略 —— 组合天气查询与时间工具生成出行建议
- weather_report(L1): 天气播报 —— 调用天气工具
- free_chat(L0): 自由聊天 —— 纯提示词技能，直接回答

根据用户输入只输出 JSON：{"skill": "技能名", "reason": "一句话理由"}
`;

export class SkillAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step10 · 技能编排（Skills L0/L1/L2）';
    }

    async chat(input) {
        this.lastTrace = [];

        // 1. 技能选择
        const raw = (await this.model.chat([Message.system(SELECT_PROMPT), Message.user(input)])).trim();
        const decision = tryParse(raw);
        let skill = str(decision, 'skill');
        if (skill == null) skill = 'free_chat';
        this.lastTrace.push({
            type: 'skill',
            label: '技能选择',
            detail: skill + '（' + (str(decision, 'reason') ?? '') + '）',
        });

        // 2. 技能执行
        switch (skill) {
            case 'travel_plan': return this.travelPlan(input);       // L1: 多工具组合
            case 'weather_report': return this.weatherReport(input); // L1: 单工具
            default: return this.freeChat(input);                    // L0: 纯提示词
        }
    }

    /** L1 技能：组合天气 + 时间两个工具，产出结构化攻略。 */
    async travelPlan(input) {
        const city = input.includes('杭州') ? '杭州' : input.includes('上海') ? '上海'
            : input.includes('成都') ? '成都' : input.includes('广州') ? '广州'
            : input.includes('深圳') ? '深圳' : '北京';
        this.lastTrace.push({ type: 'action', label: 'L1 组合工具 1/2', detail: 'get_weather(' + city + ')' });
        const weather = MockWeather.query(city);
        this.lastTrace.push({ type: 'observation', label: '工具返回', detail: weather });
        this.lastTrace.push({ type: 'action', label: 'L1 组合工具 2/2', detail: 'get_time()' });
        const time = formatTime().slice(0, 16); // yyyy-MM-dd HH:mm
        this.lastTrace.push({ type: 'observation', label: '工具返回', detail: time });

        const answer = await this.model.chat([
            Message.system('你是旅行顾问。基于给定的天气与时间信息，输出简短出行攻略（3 条以内要点）。\n'),
            Message.user(input + '\n天气: ' + weather + '\n当前时间: ' + time),
        ]);
        this.lastTrace.push({ type: 'final', label: 'L1 技能完成', detail: '两件工具的结果已拼装进提示词' });
        return answer;
    }

    /** L1 技能：单工具播报。 */
    weatherReport(input) {
        const city = input.includes('上海') ? '上海' : input.includes('杭州') ? '杭州' : '北京';
        this.lastTrace.push({ type: 'action', label: 'L1 调用工具', detail: 'get_weather(' + city + ')' });
        const weather = MockWeather.query(city);
        this.lastTrace.push({ type: 'final', label: '播报完成', detail: weather });
        return '「' + city + '」' + weather + '。';
    }

    /** L0 技能：纯提示词，不碰工具。 */
    freeChat(input) {
        this.lastTrace.push({ type: 'final', label: 'L0 提示词技能', detail: '无工具，直接对话' });
        return this.model.chat([
            Message.system('你是友好的中文助手，回答保持简洁。'),
            Message.user(input),
        ]);
    }

    trace() {
        return [...this.lastTrace];
    }
}

function str(o, key) {
    return o != null && typeof o === 'object' ? o[key] : undefined;
}

function tryParse(raw) {
    try {
        return JSON.parse(raw.replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim());
    } catch {
        return {};
    }
}
