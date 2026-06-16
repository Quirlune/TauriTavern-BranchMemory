export const EXTENSION_NAMESPACE = 'tt-branch-memory';
export const SETTINGS_TABLE = 'settings';
export const SETTINGS_KEY = 'v1';
export const SMALL_TABLE = 'memory-small-v1';
export const LARGE_TABLE = 'memory-large-v1';
export const STATUS_TABLE = 'status-v1';
export const IMAGE_TABLE = 'image-v1';
export const CHAT_RUNTIME_KEY = 'runtime-v1';

const DEFAULT_BIZYAIR_INPUT_VALUES_TEMPLATE = '{\n  "3:KSampler.seed": {{seed}},\n  "3:KSampler.steps": {{steps}},\n  "3:KSampler.cfg": {{cfg}},\n  "3:KSampler.sampler_name": "{{sampler}}",\n  "3:KSampler.scheduler": "{{scheduler}}",\n  "3:KSampler.denoise": {{denoise}},\n  "6:CLIPTextEncode.text": "{{positive_prompt}}",\n  "7:CLIPTextEncode.text": "{{negative_prompt}}",\n  "13:EmptySD3LatentImage.width": {{width}},\n  "13:EmptySD3LatentImage.height": {{height}},\n  "13:EmptySD3LatentImage.batch_size": 1\n}';

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
        debugNotifications: false,
        positionTag: 'position',
        promptTag: 'positive_prompt',
        characterPrompts: {
            fallback: '',
            records: {}
        },
        inputRegex: [],
        outputRegex: [],
        promptEntries: [
            {
                id: 'image-plan-system',
                title: '图片规划 · 系统约束',
                enabled: true,
                role: 'system',
                content: '你是插图导演。你只负责从已编号的正文分片中选择适合插图的位置，并为每个位置写出 BizyAir 正面提示词。不要续写剧情，不要解释。必须输出 XML，不要输出 JSON。每张图使用一组 <image>...</image>，其中必须包含 <{{position_tag}}>分片序号</{{position_tag}}> 和 <{{prompt_tag}}>正面提示词</{{prompt_tag}}>。只写主体、动作、场景、构图、光影和角色外貌；固定质量词前缀与负面提示词由插件负责，不需要你重复。'
            },
            {
                id: 'image-plan-user',
                title: '图片规划 · 正文输入',
                enabled: true,
                role: 'user',
                content: '当前角色：{{character_name}}\n角色外貌提示词：\n{{character_prompt}}\n\n已按段落编号的正文：\n{{body_segments}}\n\n请最多选择 {{max_images}} 个分片。每张图输出：\n<image>\n<{{position_tag}}>分片序号</{{position_tag}}>\n<{{prompt_tag}}>英文或中英混合正面生图提示词</{{prompt_tag}}>\n</image>\n\n分片序号必须来自 <segment id="...">，不要使用原文锚点。生成正面提示词时应融合角色外貌提示词，保持同一角色外观一致。'
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
            positivePromptPrefix: '',
            negativePrompt: 'low quality, blurry, bad anatomy, extra fingers, watermark, text',
            pollIntervalMs: 2000,
            maxPolls: 60,
            concurrency: 3,
            inputValuesTemplate: DEFAULT_BIZYAIR_INPUT_VALUES_TEMPLATE,
            templateLibrary: {
                activeId: 'default-zimage',
                importName: '',
                exampleCode: '',
                items: [
                    {
                        id: 'default-zimage',
                        name: '默认 zimage',
                        webAppId: 48570,
                        suppressPreviewOutput: true,
                        inputValuesTemplate: DEFAULT_BIZYAIR_INPUT_VALUES_TEMPLATE,
                        controls: {
                            width: 1024,
                            height: 1024,
                            steps: 10,
                            seed: 101,
                            randomSeed: true,
                            cfg: 1,
                            sampler: 'euler',
                            scheduler: 'simple',
                            denoise: 1,
                            positivePromptPrefix: '',
                            negativePrompt: 'low quality, blurry, bad anatomy, extra fingers, watermark, text'
                        }
                    }
                ]
            }
        }
    }
};
