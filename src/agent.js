/**
 * 智能体契约 —— 整个 ToyAgent 的灵魂只有一个方法：
 *
 *   const answer = await agent.chat(input);
 *
 * 输入一句话，输出一句话，中间发生了什么（思考、调工具、查记忆），
 * 都是这个方法内部的策略 —— 26 个场景的演进，全是围绕这个方法的展开。
 *
 * trace() 把中间过程暴露给调用方渲染（思考步骤、工具调用等），
 * 返回 [{type, label, detail}] 三段式结构。
 * reset() 供有状态场景（如记忆）清空上下文。
 */
export class Agent {

    /** 场景名称，用于展示。子类必须覆盖。 */
    name() {
        throw new Error('Agent 子类必须实现 name()');
    }

    /** 智能体最小契约：输入用户消息，返回回答（Promise<string>）。 */
    async chat(input) {
        throw new Error('Agent 子类必须实现 chat(input)');
    }

    /** 最近一次 chat 的执行轨迹（供渲染时间线），无轨迹则返回空数组。 */
    trace() {
        return [];
    }

    /** 清空场景内部状态（如记忆），无状态场景无需覆盖。 */
    reset() {
    }
}
