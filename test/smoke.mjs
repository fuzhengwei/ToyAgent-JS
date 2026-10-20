// ToyAgent-JS Mock 冒烟测试（对应 PORTING_SPEC.md 验收标准第 2 条）
// 运行：node test/smoke.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { mock, openAiOrNull } from '../src/llm/models.js';

import { ChatAgent } from '../src/agents/step01ChatAgent.js';
import { PromptAgent } from '../src/agents/step02PromptAgent.js';
import { ReActAgent } from '../src/agents/step03ReActAgent.js';
import { ToolCallAgent } from '../src/agents/step04ToolCallAgent.js';
import { MemoryAgent } from '../src/agents/step05MemoryAgent.js';
import { RouterAgent } from '../src/agents/step06RouterAgent.js';
import { RagAgent } from '../src/agents/step07RagAgent.js';
import { WikiAgent } from '../src/agents/step08WikiAgent.js';
import { McpAgent } from '../src/agents/step09McpAgent.js';
import { SkillAgent } from '../src/agents/step10SkillAgent.js';
import { RegistryAgent } from '../src/agents/step11RegistryAgent.js';
import { MultiAgent } from '../src/agents/step12MultiAgent.js';
import { SubagentAgent } from '../src/agents/step13SubagentAgent.js';
import { A2AAgent } from '../src/agents/step14A2AAgent.js';
import { LoopAgent } from '../src/agents/step15LoopAgent.js';
import { WorkflowAgent } from '../src/agents/step16WorkflowAgent.js';
import { RuntimeAgent } from '../src/agents/step17RuntimeAgent.js';
import { FullAgent } from '../src/agents/step18FullAgent.js';
import { AskAgent } from '../src/agents/step19AskAgent.js';
import { ApprovalAgent } from '../src/agents/step20ApprovalAgent.js';
import { SandboxAgent } from '../src/agents/step21SandboxAgent.js';
import { EventSourcedAgent } from '../src/agents/step22EventSourcedAgent.js';
import { PluginAgent } from '../src/agents/step23PluginAgent.js';
import { HooksAgent } from '../src/agents/step24HooksAgent.js';
import { CliAgent } from '../src/agents/step25CliAgent.js';
import { ScheduleAgent } from '../src/agents/step26ScheduleAgent.js';

if (openAiOrNull() != null) {
    console.error('检测到真实 api-key，本脚本只验证 Mock 模式。请清空 config.properties 的 api-key。');
    process.exit(1);
}

const M = id => mock(id);
let passed = 0;

async function check(title, fn) {
    await fn();
    passed++;
    console.log('PASS  ' + title);
}

// ---------- 1. step01 有回答 ----------
await check('step01 "你好" 有回答', async () => {
    const a = new ChatAgent(M('step01'));
    const ans = await a.chat('你好');
    assert.ok(ans.length > 0);
});

// ---------- 2. step03 轨迹 thought→action→observation→final ----------
await check('step03 轨迹四段齐全', async () => {
    const a = new ReActAgent(M('step03'));
    await a.chat('北京天气怎么样');
    const types = a.trace().map(t => t.type);
    assert.deepStrictEqual(types, ['thought', 'action', 'observation', 'thought', 'final']);
});

// ---------- 3. step04 走 calculator ----------
await check('step04 走 calculator 工具', async () => {
    const a = new ToolCallAgent(M('step04'));
    const ans = await a.chat('3+5等于多少');
    assert.ok(ans.includes('8.0'), ans);
    assert.strictEqual(a.trace()[0].type, 'tool');
});

// ---------- 4. step05 两轮记住名字 ----------
await check('step05 两轮记住「小傅」', async () => {
    // 「我叫什么/名字/谁/啥」是询问而非自报姓名：不进自报分支、提取时跳过疑问词
    // （Java 原版会把「什么」误当名字，四语言版本统一做了此修正）
    const lit = new MemoryAgent(M('step05'));
    await lit.chat('我叫小傅');
    const ansLiteral = await lit.chat('我叫什么');
    assert.ok(ansLiteral.includes('当然记得，你叫「小傅」'), '疑问句走回忆分支: ' + ansLiteral);
    // 用另一种问法再验证真实记忆
    const a = new MemoryAgent(M('step05'));
    await a.chat('我叫小傅');
    const ans = await a.chat('你还记得我吗');
    assert.ok(ans.includes('小傅'), ans);
});

// ---------- 5. step18 两条输入走不同分支 ----------
await check('step18 "1+1" 与 "你好" 走不同分支', async () => {
    const a = new FullAgent(M('step18'));
    const ansCalc = await a.chat('1+1');
    const t1 = a.trace().map(t => t.type);
    assert.ok(t1.includes('action'), '算式应走工具分支: ' + t1.join(','));
    assert.ok(/2\.0/.test(ansCalc) || ansCalc.includes('计算'), ansCalc);
    const b = new FullAgent(M('step18'));
    await b.chat('你好');
    const t2 = b.trace().map(t => t.type);
    assert.ok(!t2.includes('action'), '寒暄不应走工具分支: ' + t2.join(','));
});

// ---------- 6. step20 审批挂起 → 批准续跑（等价 run 两次） ----------
await check('step20 审批挂起 → 批准后续跑', async () => {
    const a = new ApprovalAgent(M('step20'));
    const first = await a.chat('给团队发一封周报邮件');
    assert.ok(first.includes('批准'), first);
    assert.ok(a.trace().some(t => t.label.includes('PENDING_APPROVAL')));
    const second = await a.chat('批准');
    assert.ok(second.includes('任务完成'), second);
    assert.ok(a.trace().some(t => t.type === 'observation' && t.label.includes('审批放行')));
});

// ---------- 7. step21 拦截 rm -rf / ----------
await check('step21 "执行：rm -rf /" 被拦截', async () => {
    const a = new SandboxAgent(M('step21'));
    const ans = await a.chat('执行：rm -rf /');
    assert.ok(ans.includes('第 2 层拦截'), ans);
});

// ---------- 8. step22 事件落盘 ----------
await check('step22 事件写入 events/step22-events.jsonl', async () => {
    const f = 'events/step22-events.jsonl';
    rmSync('events', { recursive: true, force: true });
    const a = new EventSourcedAgent(M('step22'));
    await a.chat('我叫小傅');
    assert.ok(existsSync(f), f + ' 应存在');
    const log = readFileSync(f, 'utf-8');
    assert.ok(log.includes('USER_MESSAGE_APPENDED'), log);
    assert.ok(log.includes('小傅'), log);
    // 回放投影：第二轮还记得
    const ans = await a.chat('我叫什么');
    assert.ok(ans.includes('小傅'), ans);
});

// ---------- 9. step25 执行 ls ----------
await check('step25 "列出工作区文件" 执行 ls 并返回结果', async () => {
    const a = new CliAgent(M('step25'));
    const ans = await a.chat('列出工作区文件');
    assert.ok(ans.includes('hello.txt'), ans);
    assert.ok(a.trace().some(t => t.type === 'observation' && t.label.includes('沙箱执行 ls')));
});

// ---------- 10. 其余场景各跑 1 条示例输入 ----------
await check('step02 提示词场景', async () => {
    const a = new PromptAgent(M('step02'));
    const ans = await a.chat('什么是智能体');
    assert.ok(ans.includes('三层结构') || ans.length > 0);
    assert.strictEqual(a.trace()[0].type, 'prompt');
});

await check('step06 路由（math 分支）', async () => {
    const a = new RouterAgent(M('step06'));
    const ans = await a.chat('12*8');
    assert.ok(ans.includes('计算结果：96'), ans);
});

await check('step07 RAG 检索', async () => {
    const a = new RagAgent(M('step07'));
    const ans = await a.chat('什么是 MCP 协议');
    assert.ok(ans.includes('根据检索到的资料'), ans);
});

await check('step08 Wiki 编译与提问', async () => {
    rmSync('wiki', { recursive: true, force: true });
    const a = new WikiAgent(M('step08'));
    const ans = await a.chat('编译：发布流程：每周三灰度，周五全量上线');
    assert.ok(ans.includes('已编译进项目 Wiki'), ans);
    assert.ok(existsSync('wiki/user-wiki.md'));
    const ans2 = await a.chat('发布流程是什么');
    assert.ok(ans2.length > 0);
    a.reset();
});

await check('step09 MCP tools/call', async () => {
    const a = new McpAgent(M('step09'));
    const ans = await a.chat('上海天气怎么样');
    assert.ok(ans.includes('多云，28℃'), ans);
});

await check('step10 技能 travel_plan', async () => {
    const a = new SkillAgent(M('step10'));
    const ans = await a.chat('帮我做一份杭州旅行攻略');
    assert.ok(ans.includes('杭州出行攻略'), ans);
});

await check('step11 注册表执行 + 卸载', async () => {
    const a = new RegistryAgent(M('step11'));
    const ans = await a.chat('北京天气怎么样');
    assert.ok(ans.includes('晴，26℃'), ans);
    const ans2 = await a.chat('查看工具清单');
    assert.ok(ans2.includes('get_time'), ans2);
});

await check('step12 多智能体协作', async () => {
    const a = new MultiAgent(M('step12'));
    const ans = await a.chat('写一篇关于智能体的短文');
    assert.ok(ans.includes('智能体并不神秘'), ans);
});

await check('step13 子代理 fork/spawn', async () => {
    const a = new SubagentAgent(M('step13'));
    await a.chat('记住：我最喜欢紫色');
    const forkAns = await a.chat('fork 一个子代理，让它写一句贺词');
    assert.ok(forkAns.includes('紫色'), forkAns);
    const spawnAns = await a.chat('spawn 一个子代理写贺词');
    assert.ok(!spawnAns.includes('紫色'), spawnAns);
});

await check('step14 A2A 发现名片 + 委派', async () => {
    const a = new A2AAgent(M('step14'));
    const ans = await a.chat('让翻译代理把「你好，智能体」翻译成英文');
    assert.ok(ans.includes('Hello, Agent.'), ans);
});

await check('step15 守卫 + 保险丝', async () => {
    const a = new LoopAgent(M('step15'));
    const ans = await a.chat('上海天气怎么样');
    assert.ok(ans.includes('多云，28℃'), ans);
    const b = new LoopAgent(M('step15'));
    const blocked = await b.chat('我的密码是123456');
    assert.ok(blocked.includes('拦截'), blocked);
});

await check('step16 工作流状态机', async () => {
    const a = new WorkflowAgent(M('step16'));
    const ans = await a.chat('10-3');
    assert.ok(ans.includes('计算结果 7'), ans);
});

await check('step17 死循环触发保险丝', async () => {
    const a = new RuntimeAgent(M('step17'));
    const ans = await a.chat('死循环测试');
    assert.ok(ans.includes('已达最大步数 6'), ans);
    assert.ok(a.trace().some(t => t.type === 'guard' && t.label.includes('MAX_STEPS')));
});

await check('step19 提问挂起 → 答复续跑', async () => {
    const a = new AskAgent(M('step19'));
    const q = await a.chat('帮我订一张去北京的机票');
    assert.ok(q.includes('出发地'), q);
    const ans = await a.chat('上海');
    assert.ok(ans.includes('上海 → 北京'), ans);
});

await check('step23 插件安装/调用/卸载', async () => {
    rmSync('plugins', { recursive: true, force: true });
    const a = new PluginAgent(M('step23'));
    const ins = await a.chat('安装插件');
    assert.ok(ins.includes('coin_flip') && ins.includes('uptime'), ins);
    const flip = await a.chat('掷一次硬币');
    assert.ok(flip.includes('正面') || flip.includes('反面'), flip);
    const un = await a.chat('卸载插件');
    assert.ok(un.includes('全部注销'), un);
    const miss = await a.chat('再掷一次硬币');
    assert.ok(miss.includes('未知工具'), miss);
    a.reset();
});

await check('step24 钩子 before 拦截 / after 脱敏', async () => {
    const a = new HooksAgent(M('step24'));
    const deny = await a.chat('发送：给 13812345678 发 密码是123456');
    assert.ok(deny.includes('拦截'), deny);
    const masked = await a.chat('查询：张三');
    assert.ok(masked.includes('13*********') && masked.includes('z***@example.com'), masked);
});

await check('step26 一次性定时任务触发落盘', async () => {
    rmSync('events', { recursive: true, force: true });
    const a = new ScheduleAgent(M('step26'));
    const reg = await a.chat('定时：1秒 提醒我喝水');
    assert.ok(reg.includes('job-1'), reg);
    await new Promise(r => setTimeout(r, 1500));
    const rep = await a.chat('完成了什么');
    assert.ok(rep.includes('提醒我喝水'), rep);
    assert.ok(existsSync('events/step26-tasks.jsonl'));
});

console.log('\n全部 ' + passed + ' 项冒烟测试通过 ✔');
