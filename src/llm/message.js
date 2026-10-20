/**
 * 一条对话消息。role 取值：system / user / assistant。
 *
 * 用最纯的数据结构表达 —— 智能体与模型之间流动的
 * 永远只是「角色 + 文本」，这就是一切复杂行为的原材料。
 */
export function system(content) {
    return { role: 'system', content };
}

export function user(content) {
    return { role: 'user', content };
}

export function assistant(content) {
    return { role: 'assistant', content };
}
