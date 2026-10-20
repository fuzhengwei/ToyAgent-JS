import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openAiOrNull, mock, isRealModel, realModelName } from './llm/models.js';

/**
 * ToyAgent CLI 演示运行器（替代 Java 版的 web 页面/Application）。
 *
 * 命令：
 *   node src/main.js              —— 帮助 + 场景清单
 *   node src/main.js list         —— 场景清单
 *   node src/main.js run step03 "北京天气怎么样"
 *                                 —— 单轮执行，打印回答 + 轨迹 + 耗时
 *   node src/main.js              （无 run 参数时进入交互 REPL，先选场景再对话）
 *
 * 场景注册顺序 = Java Application 的教学叙事顺序。
 */

// ------------------------------------------------------------------ 场景注册表（顺序即教学叙事顺序）

const SCENARIOS = [
    ['step01', () => import('./agents/step01ChatAgent.js'), 'ChatAgent'],
    ['step02', () => import('./agents/step02PromptAgent.js'), 'PromptAgent'],
    ['step03', () => import('./agents/step03ReActAgent.js'), 'ReActAgent'],
    ['step04', () => import('./agents/step04ToolCallAgent.js'), 'ToolCallAgent'],
    ['step05', () => import('./agents/step05MemoryAgent.js'), 'MemoryAgent'],
    ['step06', () => import('./agents/step06RouterAgent.js'), 'RouterAgent'],
    ['step09', () => import('./agents/step09McpAgent.js'), 'McpAgent'],
    ['step10', () => import('./agents/step10SkillAgent.js'), 'SkillAgent'],
    ['step07', () => import('./agents/step07RagAgent.js'), 'RagAgent'],
    ['step12', () => import('./agents/step12MultiAgent.js'), 'MultiAgent'],
    ['step15', () => import('./agents/step15LoopAgent.js'), 'LoopAgent'],
    ['step16', () => import('./agents/step16WorkflowAgent.js'), 'WorkflowAgent'],
    ['step18', () => import('./agents/step18FullAgent.js'), 'FullAgent'],
    ['step08', () => import('./agents/step08WikiAgent.js'), 'WikiAgent'],
    ['step11', () => import('./agents/step11RegistryAgent.js'), 'RegistryAgent'],
    ['step17', () => import('./agents/step17RuntimeAgent.js'), 'RuntimeAgent'],
    ['step19', () => import('./agents/step19AskAgent.js'), 'AskAgent'],
    ['step20', () => import('./agents/step20ApprovalAgent.js'), 'ApprovalAgent'],
    ['step21', () => import('./agents/step21SandboxAgent.js'), 'SandboxAgent'],
    ['step22', () => import('./agents/step22EventSourcedAgent.js'), 'EventSourcedAgent'],
    ['step23', () => import('./agents/step23PluginAgent.js'), 'PluginAgent'],
    ['step25', () => import('./agents/step25CliAgent.js'), 'CliAgent'],
    ['step13', () => import('./agents/step13SubagentAgent.js'), 'SubagentAgent'],
    ['step24', () => import('./agents/step24HooksAgent.js'), 'HooksAgent'],
    ['step14', () => import('./agents/step14A2AAgent.js'), 'A2AAgent'],
    ['step26', () => import('./agents/step26ScheduleAgent.js'), 'ScheduleAgent'],
];

/** 装配场景实例：有真实 Key 用真模型，否则该场景配 Mock 模型（与 Java Application 同构）。 */
async function createAgent(stepId) {
    const entry = SCENARIOS.find(([id]) => id === stepId);
    if (!entry) return null;
    const mod = await entry[1]();
    const Cls = mod[Object.keys(mod).find(k => k.endsWith('Agent') && k !== 'Agent')];
    const model = openAiOrNull() ?? mock(stepId);
    return new Cls(model);
}

function printBanner() {
    console.log('=========================================');
    console.log('  ToyAgent-JS · 26 个智能体教学场景');
    console.log('  模型模式: ' + (isRealModel() ? '真实模型 ' + realModelName() : 'Mock（未配置 api-key）'));
    console.log('=========================================');
}

function printScenarios() {
    console.log('可用场景（编号即教学叙事顺序）：');
    for (const [id, , cls] of SCENARIOS) {
        console.log('  ' + id.padEnd(8) + cls);
    }
}

function printHelp() {
    console.log(`
用法：
  node src/main.js                      打印本帮助与场景清单
  node src/main.js list                 打印场景清单
  node src/main.js run <stepId> "<消息>"  单轮执行指定场景
  node src/main.js                      （省略 run 时）进入交互 REPL：
                                          先输入场景编号选择场景，再循环对话
                                          /reset 清空场景状态  /exit 退出

示例：
  node src/main.js run step01 "你好"
  node src/main.js run step03 "北京天气怎么样"
  node src/main.js run step18 "1+1"
`);
    printScenarios();
}

function printTrace(agent) {
    const trace = agent.trace();
    if (trace.length === 0) return;
    console.log('--- 执行轨迹 ---');
    for (const t of trace) {
        console.log('[' + t.label + '] ' + (t.detail ?? ''));
    }
}

async function runOnce(stepId, message) {
    const agent = await createAgent(stepId);
    if (!agent) {
        console.error('未知场景: ' + stepId + '（用 list 查看全部场景）');
        return false;
    }
    const start = Date.now();
    const answer = await agent.chat(message);
    const ms = Date.now() - start;
    console.log('场景: ' + agent.name());
    console.log('回答: ' + answer);
    printTrace(agent);
    console.log('耗时: ' + ms + ' ms');
    return true;
}

async function repl() {
    printScenarios();
    const rl = createInterface({ input: stdin, output: stdout });

    // 手动维护行队列：兼容交互 TTY 与管道脚本输入（readline 的 question() 在非 TTY 下不可靠）
    const buffer = [];
    let waiter = null;
    let closed = false;
    rl.on('line', line => {
        if (waiter) { const w = waiter; waiter = null; w(line); }
        else buffer.push(line);
    });
    rl.on('close', () => {
        closed = true;
        if (waiter) { const w = waiter; waiter = null; w(null); }
    });
    const ask = promptText => {
        stdout.write(promptText);
        if (buffer.length > 0) return Promise.resolve(buffer.shift());
        if (closed) return Promise.resolve(null);
        return new Promise(resolve => { waiter = resolve; });
    };

    let agent = null;
    while (agent == null) {
        const sel = (await ask('选择场景（输入编号如 step03，或序号 1-26）：')) ?? '';
        const byIndex = /^\d+$/.test(sel.trim()) ? SCENARIOS[parseInt(sel.trim(), 10) - 1]?.[0] : null;
        const stepId = byIndex ?? (SCENARIOS.some(([id]) => id === sel.trim()) ? sel.trim() : null);
        if (stepId == null) {
            if (sel === '') { console.log('\nBye.'); rl.close(); return; }
            console.log('没有这个场景，请重新输入。');
            continue;
        }
        agent = await createAgent(stepId);
        console.log('已选择: ' + agent.name() + '（/reset 清空状态，/exit 退出）');
    }
    try {
        while (true) {
            const line = await ask('你> ');
            if (line == null) break;
            const input = line.trim();
            if (input === '') continue;
            if (input === '/exit') break;
            if (input === '/reset') {
                agent.reset();
                console.log('（场景状态已清空）');
                continue;
            }
            const start = Date.now();
            const answer = await agent.chat(input);
            const ms = Date.now() - start;
            console.log('Agent> ' + answer);
            printTrace(agent);
            console.log('耗时: ' + ms + ' ms');
        }
    } finally {
        rl.close();
    }
    console.log('Bye.');
}

async function main() {
    printBanner();
    const args = process.argv.slice(2);
    const [cmd, ...rest] = args;

    if (cmd == null || cmd === 'help') {
        printHelp();
        if (cmd == null) await repl();
        return;
    }
    if (cmd === 'list') {
        printScenarios();
        return;
    }
    if (cmd === 'run') {
        const stepId = rest[0];
        const message = rest.slice(1).join(' ');
        if (!stepId || message === '') {
            console.error('用法: node src/main.js run <stepId> "<消息>"');
            process.exitCode = 1;
            return;
        }
        const ok = await runOnce(stepId, message);
        if (!ok) process.exitCode = 1;
        return;
    }
    console.error('未知命令: ' + cmd + '（可用：help / list / run）');
    process.exitCode = 1;
}

main().catch(e => {
    console.error('[ToyAgent] 运行异常: ' + (e.stack ?? e.message));
    process.exitCode = 1;
});
