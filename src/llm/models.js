import { MockChatModel } from './mock-chat-model.js';
import { OpenAiChatModel } from './open-ai-chat-model.js';
import { readFileSync } from 'node:fs';

/**
 * 模型工厂：读取配置，产出 ChatModel。
 *
 * 配置优先级：项目运行目录 config.properties > 环境变量 > 内置默认。
 * 未配置 api-key 时 openAiOrNull() 返回 null，由上层为每个场景装配 MockChatModel。
 * （与 Java 版的差异：不含 update()/save()/useMock() —— 那是 web 页面专用。）
 */
let baseUrl;
let apiKey;
let modelName;

load();

function load() {
    const props = readProperties('config.properties');

    // 优先级：config.properties（非空值）> LLM_* 环境变量 > OPENAI_* 环境变量 > 内置默认
    // 文件里留空（api-key=）不遮蔽环境变量 —— 支持纯环境变量方式配置默认模型
    baseUrl = firstNonBlank(
        props['base-url'],
        env('LLM_BASE_URL'), env('OPENAI_BASE_URL'),
        'https://api.deepseek.com/v1');
    apiKey = firstNonBlank(
        props['api-key'],
        env('LLM_API_KEY'), env('OPENAI_API_KEY'),
        '');
    modelName = firstNonBlank(
        props['model'],
        env('LLM_MODEL'), env('OPENAI_MODEL'),
        'deepseek-chat');

    const keyFromFile = props['api-key'] != null && props['api-key'].trim() !== '';
    if (apiKey.trim() !== '') {
        console.log('[ToyAgent] 默认模型: ' + modelName + ' @ ' + baseUrl
            + (keyFromFile ? '（Key 来自 config.properties）' : '（Key 来自环境变量）'));
    }
}

/** 极简 .properties 解析：跳过注释与空行，按第一个 = 或 : 分割。 */
function readProperties(file) {
    const props = {};
    try {
        const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
        for (const raw of lines) {
            const line = raw.trim();
            if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
            const idx = line.search(/[=:]/);
            if (idx < 0) continue;
            props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
    } catch {
        // 文件不存在 → 全部走环境变量与默认值
    }
    return props;
}

/** 返回第一个非空值；全空则返回最后一个（内置默认）。 */
function firstNonBlank(...vals) {
    for (let i = 0; i < vals.length - 1; i++) {
        if (vals[i] != null && vals[i].trim() !== '') return vals[i];
    }
    return vals[vals.length - 1];
}

function env(key) {
    const v = process.env[key];
    return v == null || v.trim() === '' ? null : v;
}

/** 有真实 Key 则返回 OpenAI 兼容模型，否则返回 null（使用 Mock）。 */
export function openAiOrNull() {
    if (apiKey == null || apiKey.trim() === '') return null;
    return new OpenAiChatModel(baseUrl, apiKey, modelName);
}

/** 教学演示用 Mock 模型。 */
export function mock(scenario) {
    return new MockChatModel(scenario);
}

export function isRealModel() {
    return apiKey != null && apiKey.trim() !== '';
}

export function realModelName() {
    return modelName;
}
