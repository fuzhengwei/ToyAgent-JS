import { ChatModel } from './chat-model.js';

/**
 * OpenAI 兼容协议的模型实现（DeepSeek / 通义 / 智谱 / 火山方舟等均适用）。
 *
 * 核心就一次 HTTP 调用：POST {base-url}/chat/completions，
 * 请求体是 messages 数组，响应里取 choices[0].message.content。
 * 所有"大模型"对你而言都只是这一个端点。
 */
export class OpenAiChatModel extends ChatModel {

    constructor(baseUrl, apiKey, model) {
        super();
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiKey = apiKey;
        this.model = model;
    }

    async chat(messages) {
        // 1. 组装请求体：{"model": "...", "messages": [{"role": "...", "content": "..."}]}
        const body = {
            model: this.model,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            temperature: 0.7,
        };

        let response;
        try {
            // 2. 调用模型（Node >= 18 全局 fetch，零依赖）
            response = await fetch(this.baseUrl + '/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + this.apiKey,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120_000),
            });
        } catch (e) {
            throw new Error('模型调用异常: ' + e.message);
        }

        const text = await response.text();
        if (response.status !== 200) {
            throw new Error('模型调用失败 HTTP ' + response.status + ': ' + snippet(text));
        }
        // 3. 解析响应：choices[0].message.content
        try {
            const root = JSON.parse(text);
            return String(root.choices[0].message.content);
        } catch (e) {
            throw new Error('模型调用异常: ' + e.message);
        }
    }
}

function snippet(s) {
    if (s == null) return '';
    return s.length > 300 ? s.slice(0, 300) + '...' : s;
}
