export const EXTENSION_NAMESPACE = 'tt-branch-memory';
export const SETTINGS_TABLE = 'settings';
export const SETTINGS_KEY = 'v1';
export const SMALL_TABLE = 'memory-small-v1';
export const LARGE_TABLE = 'memory-large-v1';
export const STATUS_TABLE = 'status-v1';
export const IMAGE_TABLE = 'image-v1';
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
        injection: {
            enabled: false,
            position: 'in_chat',
            depth: 4,
            role: 'system',
            template: '<branch_status>\n{{status}}\n</branch_status>',
            outputRegex: [
                {
                    id: 'status-injection-tags',
                    name: '正文注入提取 status 标签（默认关闭）',
                    enabled: false,
                    pattern: '^[\\s\\S]*?<status>([\\s\\S]*?)<\\/status>[\\s\\S]*$',
                    flags: 'i',
                    replacement: '$1'
                }
            ]
        },
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
    },
    image: {
        enabled: false,
        autoGenerate: true,
        api: {
            mode: 'current',
            connectionProfileId: '',
            includePreset: true
        },
        contextFloors: 2,
        responseLength: 900,
        maxImagesPerMessage: 3,
        cacheAsDataUrl: true,
        characterPrompts: {
            fallback: '',
            records: {}
        },
        inputRegex: [],
        outputRegex: [
            {
                id: 'image-plan-json',
                name: '提取 JSON 代码块（默认关闭）',
                enabled: false,
                pattern: '^[\\s\\S]*?```(?:json)?\\s*([\\s\\S]*?)```[\\s\\S]*$',
                flags: 'i',
                replacement: '$1'
            }
        ],
        promptEntries: [
            {
                id: 'image-plan-system',
                title: '图片规划 · 系统约束',
                enabled: true,
                role: 'system',
                content: '你是插图导演。你只负责从正文中选择 2 到 3 个适合插图的位置，并为每个位置写出 BizyAir 生图提示词。不要续写剧情。必须输出 JSON，不要输出解释。'
            },
            {
                id: 'image-plan-user',
                title: '图片规划 · 正文输入',
                enabled: true,
                role: 'user',
                content: '当前角色：{{character_name}}\n角色外貌提示词：\n{{character_prompt}}\n\n正文如下：\n{{body}}\n\n请输出 JSON 数组，最多 {{max_images}} 项。每项格式：{"anchor":"正文里用于定位的连续原文短句","placement":"after","occurrence":1,"prompt":"英文或中英混合生图提示词"}。anchor 必须逐字来自正文，尽量选择 8 到 30 个字符的唯一短句。placement 只能是 before、after 或 replace。生成 prompt 时应融合角色外貌提示词，保持同一角色外观一致。'
            }
        ],
        bizyair: {
            apiKeys: '',
            webAppId: 48570,
            suppressPreviewOutput: true,
            width: 1024,
            height: 1024,
            steps: 10,
            seed: 101,
            randomSeed: true,
            cfg: 1,
            sampler: 'euler',
            scheduler: 'simple',
            denoise: 1,
            negativePrompt: 'low quality, blurry, bad anatomy, extra fingers, watermark, text',
            pollIntervalMs: 2000,
            maxPolls: 60,
            inputValuesTemplate: '{\n  "3:KSampler.seed": {{seed}},\n  "3:KSampler.steps": {{steps}},\n  "3:KSampler.cfg": {{cfg}},\n  "3:KSampler.sampler_name": "{{sampler}}",\n  "3:KSampler.scheduler": "{{scheduler}}",\n  "3:KSampler.denoise": {{denoise}},\n  "6:CLIPTextEncode.text": "{{positive_prompt}}",\n  "7:CLIPTextEncode.text": "{{negative_prompt}}",\n  "13:EmptySD3LatentImage.width": {{width}},\n  "13:EmptySD3LatentImage.height": {{height}},\n  "13:EmptySD3LatentImage.batch_size": 1\n}'
        }
    }
};
