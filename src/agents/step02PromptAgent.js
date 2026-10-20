import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step02 · 提示词工程 —— 给模型一份"角色说明书"。
 *
 * 与 Step01 唯一的区别：调用模型前，先塞入一条 system 消息。
 * 系统提示词采用经典三层结构：角色（你是谁）→ 背景（约束与风格）→ 任务（怎么干）。
 * 同一个模型，换一份提示词就换了一种"人格"与输出格式 —— 这就是提示词工程的杠杆。
 */

/** 三层结构系统提示词：角色 → 背景 → 任务与约束。 */
export const SYSTEM_PROMPT = `# 角色
你是小傅哥的技术助理，专注讲清楚 AI Agent 的原理与工程实践。

# 背景
读者是正在学习智能体开发的 Java 工程师，熟悉后端技术，但对 AI 领域是新手。

# 任务与约束
1. 回答使用简体中文，口语化但专业。
2. 先给结论，再展开解释；涉及概念时给出生活化类比。
3. 若用户要求"用一句话"，必须严格只回答一句话。
4. 不确定的内容要如实说明，禁止编造。
`;

export class PromptAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step02 · 提示词工程（系统提示词三层结构）';
    }

    async chat(input) {
        this.lastTrace = [];
        this.lastTrace.push({
            type: 'prompt', label: '注入系统提示词',
            detail: '角色/背景/任务 三层结构，长度 ' + SYSTEM_PROMPT.length + ' 字符',
        });
        const answer = await this.model.chat([
            Message.system(SYSTEM_PROMPT),
            Message.user(input),
        ]);
        this.lastTrace.push({
            type: 'prompt', label: '模型按人设作答',
            detail: '输出风格由 system 消息约束',
        });
        return answer;
    }

    trace() {
        return [...this.lastTrace];
    }
}
