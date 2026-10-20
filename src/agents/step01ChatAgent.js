import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step01 · 对话智能体 —— 智能体的最小 MVP。
 *
 * 一个接口，一个方法，没有策略、没有工具、没有记忆。
 * 它证明了一件事：所谓智能体，起点只是「把用户的话交给模型，把模型的话还给用户」。
 * 后续 25 个场景，都是往这个最小骨架里加入一种能力。
 */
export class ChatAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
    }

    name() {
        return 'Step01 · 对话智能体（最小 MVP）';
    }

    async chat(input) {
        // 全部实现就这一行核心逻辑
        return this.model.chat([Message.user(input)]);
    }
}
