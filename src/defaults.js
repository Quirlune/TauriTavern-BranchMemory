export const EXTENSION_NAMESPACE = 'tt-branch-memory';
export const SETTINGS_TABLE = 'settings';
export const SETTINGS_KEY = 'v1';
export const SMALL_TABLE = 'memory-small-v1';
export const LARGE_TABLE = 'memory-large-v1';
export const STATUS_TABLE = 'status-v1';
export const CHAT_RUNTIME_KEY = 'runtime-v1';

export const DEFAULT_SETTINGS = {
    version: 1,
    enabled: true,
    memory: {
        enabled: true,
        api: {
            mode: 'current',
            connectionProfileId: '',
            includePreset: true
        },
        smallEvery: 8,
        largeEvery: 32,
        reserveFloors: 4,
        maxCallsPerTurn: 2,
        responseLength: 700,
        inputRegex: [],
        outputRegex: [
            {
                id: 'memory-tags',
                name: '提取 memory 标签（默认关闭）',
                enabled: false,
                pattern: '^[\\s\\S]*?<memory>([\\s\\S]*?)<\\/memory>[\\s\\S]*$',
                flags: 'i',
                replacement: '$1'
            }
        ],
        smallPromptEntries: [
            {
                id: 'small-system',
                title: '小总结 · 系统约束',
                enabled: true,
                role: 'system',
                content: '你是长期角色扮演记忆整理器。只记录可在后续对话中复用的事实、关系变化、承诺、目标、物品、地点、时间线与未解决事项。不要续写剧情，不要评价写作，不要捏造。'
            },
            {
                id: 'small-user',
                title: '小总结 · 本段输入',
                enabled: true,
                role: 'user',
                content: '请总结用户楼层 {{floor_start}} 到 {{floor_end}}。\n\n已有大总结：\n{{previous_large}}\n\n本段对话：\n{{chat}}\n\n直接输出可复用的小总结。'
            }
        ],
        largePromptEntries: [
            {
                id: 'large-system',
                title: '大总结 · 系统约束',
                enabled: true,
                role: 'system',
                content: '你是长期角色扮演记忆压缩器。把旧的大总结、阶段小总结和必要原文合并为一份累计记忆。保留稳定事实、人物关系、长期目标、关键因果、重要原话含义与未解决伏笔；删除重复和过时细节。不要续写剧情。'
            },
            {
                id: 'large-user',
                title: '大总结 · 叠层输入',
                enabled: true,
                role: 'user',
                content: '请生成截至用户第 {{floor_end}} 楼的累计大总结。\n\n上一份大总结：\n{{previous_large}}\n\n此阶段小总结：\n{{small_summaries}}\n\n此阶段原始对话：\n{{chat}}\n\n直接输出累计大总结。'
            }
        ],
        injection: {
            enabled: true,
            position: 'in_chat',
            depth: 4,
            role: 'system',
            template: '<branch_memory>\n{{large_memory}}\n{{small_memory}}\n</branch_memory>'
        }
    },
    status: {
        enabled: true,
        renderDepth: 0,
        api: {
            mode: 'current',
            connectionProfileId: '',
            includePreset: true
        },
        contextFloors: 6,
        responseLength: 350,
        inputRegex: [],
        outputRegex: [
            {
                id: 'status-tags',
                name: '提取 status 标签（默认关闭）',
                enabled: false,
                pattern: '^[\\s\\S]*?<status>([\\s\\S]*?)<\\/status>[\\s\\S]*$',
                flags: 'i',
                replacement: '$1'
            }
        ],
        promptEntries: [
            {
                id: 'status-system',
                title: '状态栏 · 系统约束',
                enabled: true,
                role: 'system',
                content: '你只负责根据当前剧情生成状态栏数据。不要续写剧情，不要解释。严格服从用户定义的格式。'
            },
            {
                id: 'status-user',
                title: '状态栏 · 输入',
                enabled: true,
                role: 'user',
                content: '记忆：\n{{memory}}\n\n最近对话：\n{{chat}}\n\n上一版状态：\n{{previous_status}}\n\n生成新的状态栏内容。'
            }
        ],
        renderAsHtml: false,
        htmlTemplate: '<div class="ttbm-status-card"><div class="ttbm-status-title">STATUS</div><div class="ttbm-status-content">{{status}}</div></div>',
        css: '.ttbm-status-card { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor) 24%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 88%, transparent); }\n.ttbm-status-title { margin-bottom: 6px; font-size: 11px; letter-spacing: .16em; opacity: .62; }\n.ttbm-status-content { white-space: pre-wrap; line-height: 1.45; }'
    }
};
