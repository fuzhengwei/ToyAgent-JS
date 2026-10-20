import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { ToolRegistry } from './step11RegistryAgent.js';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Step23 · 插件机制 —— 把「一批工具」打包成可安装、可卸载的插件。
 *
 * 与 Step11 的关系：Step11 解决「工具怎么注册」，本步解决「工具从哪来」——
 * 插件是工具的动态载体：安装插件 = 批量注册，卸载插件 = 批量调用 disposer。
 * 对应 deepseek-harness-java 的 JavaPluginLoader + PluginToolBridgeService。
 *
 * 四个关键设计（与 dsh-java 一一对应）：
 * 1. 契约 SPI：AgentPlugin 接口（id/onStart/onStop/tools），等价 dsh-java 的 JavaHarnessPlugin + PluginManifest；
 * 2. 隔离加载：Java 用独立 URLClassLoader；JS 适配为动态 import() 独立模块文件
 *    （插件模块只依赖宿主注入的契约形状，卸载后引用即释放）；
 * 3. 生命周期：install → onStart → 收集工具 → 批量注册 →（卸载）批量注销 → onStop；
 * 4. 工具桥接：插件的 ToolDefinition 注册进 ToolRegistry，模型立即「看见」——
 *    注册项的 disposer 按 pluginId 归档，即 dsh-java 的 PluginToolBridgeService.pluginDisposers。
 *
 * 试试本场景的本地指令：
 *   安装插件                —— 释放插件包 → 动态加载 → 批量注册 2 个工具
 *   查看工具清单            —— 注册表当前内容（模型看到的清单）
 *   掷一次硬币 / 运行多久了  —— 调用插件带来的工具
 *   卸载插件                —— 批量注销 + onStop
 *   再看看工具清单          —— 插件工具已消失，宿主回到零工具
 */

/** 插件契约：插件作者唯一需要实现的东西（dsh-java 的 JavaHarnessPlugin 简化版）。 */
export class AgentPlugin {
    /** 插件唯一标识，卸载时靠它批量回收注册项。 */
    id() { throw new Error('AgentPlugin 子类必须实现 id()'); }
    /** 插件版本。 */
    version() { throw new Error('AgentPlugin 子类必须实现 version()'); }
    /** 生命周期：安装/激活后由宿主调用一次。 */
    onStart() { }
    /** 生命周期：卸载前由宿主调用一次，释放插件自有资源。 */
    onStop() { }
    /** 插件带来的工具：宿主逐个注册进 ToolRegistry。 */
    tools() { throw new Error('AgentPlugin 子类必须实现 tools()'); }
}

const PLUGIN_DIR = path.join('plugins', 'step23');

/**
 * 演示插件源码 —— 如果它有 main 函数的人生，这就是「插件作者」写的全部代码：
 * 实现 AgentPlugin 契约，onStart 打个招呼，tools() 返回带来的工具。
 * 安装时它会被释放到 plugins/ 目录、经动态 import 隔离加载 —— 与宿主代码分离。
 */
const PLUGIN_SOURCE = `// ToyAgent 演示插件 time-plugin（由宿主释放，模拟用户放入插件包）
import { AgentPlugin } from '${pathToFileURL(path.resolve('src', 'agents', 'step23PluginAgent.js')).href}';

export class TimePlugin extends AgentPlugin {
    constructor() {
        super();
        this.started = false;
        this.installedAt = Date.now();
    }

    id() { return 'time-plugin'; }
    version() { return '1.0.0'; }

    onStart() { this.started = true; }
    onStop() { this.started = false; }

    tools() {
        const self = this;
        return [
            // 工具 1：宿主进程运行时长 —— 插件工具也能反查宿主状态
            {
                name() { return 'uptime'; },
                description() { return '查询宿主进程已运行时长'; },
                parameters() { return {}; },
                execute() {
                    const sec = Math.floor((Date.now() - self.installedAt) / 1000);
                    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
                    return '宿主已运行 ' + h + ' 小时 ' + m + ' 分 ' + s + ' 秒';
                },
            },
            // 工具 2：掷硬币 —— 一个纯粹由插件带来的趣味能力
            {
                name() { return 'coin_flip'; },
                description() { return '掷一次硬币，返回正面或反面'; },
                parameters() { return {}; },
                execute() {
                    return Math.random() < 0.5 ? '正面' : '反面';
                },
            },
        ];
    }
}

export default TimePlugin;
`;

const SYSTEM_PROMPT_PREFIX = `你是一个可以调用工具的智能体。可用工具清单（由注册表自动生成，工具由插件提供）：
`;

export class PluginAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.registry = new ToolRegistry();
        this.startedAt = Date.now();
        /** 已安装插件：pluginId → 已加载实例与回收资源。 */
        this.installed = new Map();
        this.lastTrace = [];
    }

    name() {
        return 'Step23 · 插件机制（JavaPluginLoader 隔离加载）';
    }

    async chat(input) {
        this.lastTrace = [];
        this.lastTrace.push({
            type: 'tool', label: '注册表就绪',
            detail: '宿主内置 0 个工具 —— 能力全部由插件装进来（已安装 ' + this.installed.size + ' 个插件）',
        });

        // ---- 本地指令 1：安装插件 ----
        if (input.includes('安装插件') || input.includes('装载插件')) {
            return this.install();
        }

        // ---- 本地指令 2：卸载插件 ----
        if (input.includes('卸载插件') || input.includes('移除插件')) {
            return this.uninstall();
        }

        // ---- 本地指令 3：查看工具清单 ----
        if (input.includes('查看工具') || input.includes('工具清单')) {
            const list = this.installed.size === 0 ? '（无）' : [...this.installed.keys()].join('、');
            this.lastTrace.push({
                type: 'prompt', label: '工具清单 promptCatalog()',
                detail: this.registry.isEmpty() ? '（注册表为空）' : this.registry.promptCatalog().trim(),
            });
            return '已安装插件：' + list + '\n当前注册表共 ' + this.registry.size() + ' 个工具：\n'
                + (this.registry.isEmpty() ? '（空）' : this.registry.promptCatalog())
                + '\n插件注册的工具对模型完全透明 —— 它只看得到清单，不知道工具是内置的还是插件带来的。';
        }

        // ---- 常规对话：清单进提示词 → 模型决策 → 注册表执行 ----
        const messages = [
            Message.system(SYSTEM_PROMPT_PREFIX + (this.registry.isEmpty() ? '（当前没有任何工具）' : this.registry.promptCatalog())
                + '\n决策规则：\n- 需要工具时，只输出 JSON：{"tool": "工具名", "arguments": {}}\n'
                + '- 不需要工具时，直接用自然语言回答，不要输出 JSON。'),
            Message.user(input),
        ];

        for (let round = 1; round <= 2; round++) {
            const raw = (await this.model.chat(messages)).trim();
            const decision = tryParse(raw);

            if (decision && typeof decision === 'object' && str(decision, 'tool') != null) {
                const toolName = decision.tool;
                this.lastTrace.push({
                    type: 'action', label: '模型发起工具调用',
                    detail: toolName + ' ' + JSON.stringify(decision.arguments),
                });

                const tool = this.registry.lookup(toolName);
                let result;
                if (tool == null) {
                    result = '未知工具: ' + toolName + '（插件未安装，或已被卸载）';
                    this.lastTrace.push({
                        type: 'guard', label: '注册表未命中',
                        detail: '卸载插件后其工具随之消失 —— 模型看不见，也调不到',
                    });
                } else {
                    try {
                        result = await tool.execute({});
                    } catch (e) {
                        result = '工具执行失败: ' + e.message;
                    }
                    this.lastTrace.push({ type: 'observation', label: '注册表执行 ' + toolName, detail: result });
                }

                messages.push(Message.assistant(raw));
                messages.push(Message.user('工具 ' + toolName + ' 执行结果: ' + result));
                continue;
            }

            this.lastTrace.push({
                type: 'final', label: '最终回答',
                detail: '模型基于插件注册的工具完成决策',
            });
            return raw;
        }
        return '已达最大轮数，循环终止。';
    }

    /** 安装：释放插件包 → 隔离加载 → onStart → 收集工具 → 批量注册。 */
    async install() {
        if (this.installed.size > 0) {
            return '已有插件在运行：' + [...this.installed.keys()].join('、') + '。先卸载再安装其他插件。';
        }
        try {
            // 1. 释放插件包（真实场景：用户下载插件文件放入 plugins/ 目录）
            this.materializePluginPackage();
            this.lastTrace.push({
                type: 'tool', label: '插件包落盘 ' + PLUGIN_DIR,
                detail: 'time-plugin.mjs + plugin.properties（entrypoint 声明入口模块，等价 dsh-java 的 META-INF/plugin.yaml）',
            });

            // 2. 动态 import 隔离加载：插件模块独立成文件，与宿主代码分离（Java 版为独立 URLClassLoader）
            try {
                const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'time-plugin.mjs')).href);
                const plugin = new (mod.TimePlugin ?? mod.default)();
                plugin.onStart();
                this.lastTrace.push({
                    type: 'action', label: '动态 import 隔离加载',
                    detail: '入口 TimePlugin 实例化成功，onStart() 已调用 —— 模块与宿主分离，卸载时释放引用',
                });

                // 3. 工具桥接：逐个注册，disposer 按 pluginId 归档（dsh-java: pluginDisposers）
                const toolNames = [];
                const disposers = [];
                for (const tool of plugin.tools()) {
                    disposers.push(this.registry.register(tool));
                    toolNames.push(tool.name());
                }
                this.lastTrace.push({
                    type: 'observation', label: '工具桥接 batch register',
                    detail: toolNames + ' 已注册进 ToolRegistry，disposers 按 pluginId 归档 —— 卸载即批量注销',
                });

                this.installed.set(plugin.id(), { plugin, toolNames, disposers });
                return '插件 ' + plugin.id() + ' v' + plugin.version() + ' 安装成功，带来 ' + toolNames.length
                    + ' 个工具：\n' + this.registry.promptCatalog()
                    + '\n现在可以直接对话使用（如「掷一次硬币」「运行多久了」），模型自动看见新工具。';
            } catch (e) {
                return '插件加载失败：' + e.message;
            }
        } catch (e) {
            return '插件包落盘失败：' + e.message;
        }
    }

    /** 卸载：批量注销工具 → onStop。 */
    uninstall() {
        if (this.installed.size === 0) {
            return '当前没有已安装的插件。先试试「安装插件」。';
        }
        let sb = '';
        for (const [id, loaded] of this.installed) {
            for (const d of loaded.disposers) d();
            loaded.plugin.onStop();
            this.lastTrace.push({
                type: 'guard', label: '卸载 ' + id,
                detail: loaded.toolNames + ' 已批量注销，onStop() 已调用，插件模块引用已释放',
            });
            sb += loaded.toolNames + ' ';
        }
        this.installed.clear();
        return '插件已卸载，工具 ' + sb + '全部注销。注册表回到 ' + this.registry.size()
            + ' 个工具 —— 插件机制的三步回收：批量 disposer → onStop → 释放模块引用。\n'
            + '现在再让模型掷硬币，它会说工具不存在 —— 卸载即消失。';
    }

    /** 把插件源码释放到 plugins/ 目录，并写入迷你清单。 */
    materializePluginPackage() {
        mkdirSync(PLUGIN_DIR, { recursive: true });
        writeFileSync(path.join(PLUGIN_DIR, 'time-plugin.mjs'), PLUGIN_SOURCE, 'utf-8');
        const manifest = '# mini plugin manifest (dsh-java 用 META-INF/plugin.yaml)\n'
            + 'id=time-plugin\n'
            + 'version=1.0.0\n'
            + 'entrypoint=time-plugin.mjs\n';
        writeFileSync(path.join(PLUGIN_DIR, 'plugin.properties'), manifest, 'utf-8');
    }

    reset() {
        for (const [, loaded] of this.installed) {
            for (const d of loaded.disposers) d();
            loaded.plugin.onStop();
        }
        this.installed.clear();
        this.registry.clear();
        try {
            if (existsSync(PLUGIN_DIR)) rmSync(PLUGIN_DIR, { recursive: true, force: true });
        } catch {
            // 清理失败不影响会话
        }
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
        return raw;
    }
}
