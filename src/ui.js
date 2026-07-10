import { DOMPurify } from '/lib.js';
import { escapeHtml, parseBizyAirApiExample, statusInsertionIndex, uniqueId } from './core.js';

function readPath(target, path) {
    return path.split('.').reduce((value, key) => value?.[key], target);
}

function writePath(target, path, value) {
    const keys = path.split('.');
    const finalKey = keys.pop();
    const parent = keys.reduce((object, key) => object[key], target);
    parent[finalKey] = value;
}

function option(value, label, current) {
    return `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
}

function promptEntriesHtml(entries, listPath) {
    return (entries || []).map((entry, index) => `
        <article class="ttbm-card" data-list-path="${listPath}" data-index="${index}">
            <div class="ttbm-card-head">
                <label class="ttbm-grow">名称<input class="ttbm-entry-title text_pole" value="${escapeHtml(entry.title)}"></label>
                <label>角色<select class="ttbm-entry-role text_pole">
                    ${option('system', 'system', entry.role)}
                    ${option('user', 'user', entry.role)}
                    ${option('assistant', 'assistant', entry.role)}
                </select></label>
                <label class="ttbm-check"><input class="ttbm-entry-enabled" type="checkbox" ${entry.enabled ? 'checked' : ''}>启用</label>
            </div>
            <textarea class="ttbm-entry-content text_pole" rows="7">${escapeHtml(entry.content)}</textarea>
            <div class="ttbm-card-actions">
                <button class="menu_button ttbm-move-up" type="button">上移</button>
                <button class="menu_button ttbm-move-down" type="button">下移</button>
                <button class="menu_button ttbm-remove-entry" type="button">删除</button>
            </div>
        </article>
    `).join('');
}

function regexRulesHtml(rules, listPath) {
    return (rules || []).map((rule, index) => `
        <article class="ttbm-card ttbm-regex-card" data-list-path="${listPath}" data-index="${index}">
            <div class="ttbm-card-head">
                <label class="ttbm-grow">规则名<input class="ttbm-rule-name text_pole" value="${escapeHtml(rule.name)}"></label>
                <label>flags<input class="ttbm-rule-flags text_pole" value="${escapeHtml(rule.flags || 'g')}"></label>
                <label class="ttbm-check"><input class="ttbm-rule-enabled" type="checkbox" ${rule.enabled ? 'checked' : ''}>启用</label>
            </div>
            <label>查找正则<textarea class="ttbm-rule-pattern text_pole" rows="3">${escapeHtml(rule.pattern)}</textarea></label>
            <label>替换为<textarea class="ttbm-rule-replacement text_pole" rows="2">${escapeHtml(rule.replacement)}</textarea></label>
            <div class="ttbm-card-actions">
                <button class="menu_button ttbm-move-up" type="button">上移</button>
                <button class="menu_button ttbm-move-down" type="button">下移</button>
                <button class="menu_button ttbm-remove-entry" type="button">删除</button>
            </div>
        </article>
    `).join('');
}

function numberField(label, path, value, min = 0, max = 100000) {
    return `<label>${label}<input class="text_pole" type="number" min="${min}" max="${max}" data-setting="${path}" value="${value}"></label>`;
}

function monitorRecordHtml(record) {
    const time = new Date(record.timestamp).toLocaleTimeString();
    return `
        <details class="ttbm-monitor-event ttbm-monitor-${escapeHtml(record.level)}" data-monitor-id="${escapeHtml(record.id)}">
            <summary>
                <time>${escapeHtml(time)}</time>
                <span class="ttbm-monitor-channel">${escapeHtml(record.channel)}</span>
                <strong>${escapeHtml(record.type)}</strong>
            </summary>
            <pre class="ttbm-monitor-json">展开后加载完整事件数据</pre>
        </details>
    `;
}

export class SettingsUi {
    constructor({ settings, monitor, getConnectionProfiles = () => [], getCurrentCharacterInfo = () => null, onSettingsChanged, onRunNow }) {
        this.settings = settings;
        this.monitor = monitor;
        this.monitorState = monitor?.snapshot() || { active: false, records: [], maxEvents: 300 };
        this.getConnectionProfiles = getConnectionProfiles;
        this.getCurrentCharacterInfo = getCurrentCharacterInfo;
        this.onSettingsChanged = onSettingsChanged;
        this.onRunNow = onRunNow;
        this.stats = null;
        this.modalTab = 'memory';
    }

    mount() {
        this.#mountSettingsEntry();
        this.#mountModal();
        this.#bindEvents();
        this.renderModal();
    }

    #mountSettingsEntry() {
        if (document.getElementById('ttbm-settings-entry')) return;
        const target = document.querySelector('#extensions_settings2') || document.body;
        target.insertAdjacentHTML('beforeend', `
            <div id="ttbm-settings-entry" class="ttbm-settings-entry inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Branch Memory, Status & Images</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label"><input id="ttbm-master-enabled" type="checkbox">启用扩展</label>
                    <div class="ttbm-inline-actions">
                        <button id="ttbm-open-settings" class="menu_button" type="button">详细设置</button>
                        <button id="ttbm-run-now" class="menu_button" type="button">立即同步</button>
                        <button id="ttbm-open-monitor" class="menu_button" type="button">调用监控</button>
                    </div>
                    <small>楼层只计算 user 消息；AI 消息不计楼。摘要以消息链锚点跨分支复用。</small>
                </div>
            </div>
        `);
        document.getElementById('ttbm-master-enabled').checked = this.settings.enabled;
    }

    #mountModal() {
        if (document.getElementById('ttbm-modal')) return;
        document.body.insertAdjacentHTML('beforeend', `
            <div id="ttbm-modal" class="ttbm-modal" hidden>
                <div class="ttbm-modal-backdrop" data-close-modal></div>
                <section class="ttbm-modal-panel" role="dialog" aria-modal="true" aria-label="Branch Memory 设置">
                    <header class="ttbm-modal-head">
                        <div><strong>Branch Memory, Status & Images</strong><small>分支记忆、独立状态栏与 BizyAir 插图</small></div>
                        <button class="menu_button" type="button" data-close-modal>关闭</button>
                    </header>
                    <nav class="ttbm-tabs">
                        <button class="menu_button" data-tab="memory" type="button">记忆模块</button>
                        <button class="menu_button" data-tab="status" type="button">状态栏模块</button>
                        <button class="menu_button" data-tab="image" type="button">图片模块</button>
                        <button class="menu_button" data-tab="runtime" type="button">运行状态</button>
                        <button class="menu_button" data-tab="monitor" type="button">调用监控</button>
                    </nav>
                    <div id="ttbm-modal-body" class="ttbm-modal-body"></div>
                </section>
            </div>
        `);
    }

    #bindEvents() {
        document.getElementById('ttbm-open-settings').addEventListener('click', () => this.open());
        document.getElementById('ttbm-run-now').addEventListener('click', () => this.onRunNow());
        document.getElementById('ttbm-open-monitor').addEventListener('click', () => {
            this.monitor?.start();
            this.modalTab = 'monitor';
            this.open();
        });
        document.getElementById('ttbm-master-enabled').addEventListener('change', (event) => {
            this.settings.enabled = event.target.checked;
            this.#changed(true);
        });

        const modal = document.getElementById('ttbm-modal');
        modal.addEventListener('click', (event) => {
            const close = event.target.closest('[data-close-modal]');
            if (close) this.close();

            const tab = event.target.closest('[data-tab]');
            if (tab) {
                this.modalTab = tab.dataset.tab;
                if (this.modalTab === 'monitor') this.monitor?.start();
                this.renderModal();
            }

            if (event.target.closest('#ttbm-runtime-run')) {
                this.onRunNow();
            }

            const monitorAction = event.target.closest('[data-monitor-action]')?.dataset.monitorAction;
            if (monitorAction === 'toggle') {
                this.monitorState.active ? this.monitor?.stop() : this.monitor?.start();
                this.renderModal();
            }
            if (monitorAction === 'clear') {
                this.monitor?.clear();
                this.renderModal();
            }
            if (monitorAction === 'expand' || monitorAction === 'collapse') {
                const open = monitorAction === 'expand';
                document.querySelectorAll('#ttbm-monitor-list details').forEach(details => {
                    details.open = open;
                    if (open) this.#populateMonitorDetail(details);
                });
            }

            const templateAction = event.target.closest('[data-bizyair-template-action]')?.dataset.bizyairTemplateAction;
            if (templateAction === 'parse-save') {
                this.#parseBizyAirTemplate();
                return;
            }
            if (templateAction === 'delete') {
                this.#deleteBizyAirTemplate();
                return;
            }

            const addEntry = event.target.closest('[data-add-entry]');
            if (addEntry) {
                const list = readPath(this.settings, addEntry.dataset.addEntry);
                list.push({ id: uniqueId('prompt'), title: '新条目', enabled: true, role: 'user', content: '' });
                this.renderModal();
                this.#changed(true);
            }

            const addRule = event.target.closest('[data-add-rule]');
            if (addRule) {
                const list = readPath(this.settings, addRule.dataset.addRule);
                list.push({ id: uniqueId('regex'), name: '新正则', enabled: true, pattern: '', flags: 'g', replacement: '' });
                this.renderModal();
                this.#changed(true);
            }

            const card = event.target.closest('[data-list-path][data-index]');
            if (!card) return;
            const list = readPath(this.settings, card.dataset.listPath);
            const index = Number(card.dataset.index);
            if (event.target.closest('.ttbm-remove-entry')) {
                list.splice(index, 1);
                this.renderModal();
                this.#changed(true);
            } else if (event.target.closest('.ttbm-move-up') && index > 0) {
                [list[index - 1], list[index]] = [list[index], list[index - 1]];
                this.renderModal();
                this.#changed(true);
            } else if (event.target.closest('.ttbm-move-down') && index < list.length - 1) {
                [list[index + 1], list[index]] = [list[index], list[index + 1]];
                this.renderModal();
                this.#changed(true);
            }
        });

        modal.addEventListener('input', (event) => this.#readInput(event));
        modal.addEventListener('change', (event) => this.#readInput(event));
        modal.addEventListener('toggle', (event) => {
            const details = event.target.closest?.('[data-monitor-id]');
            if (details?.open) this.#populateMonitorDetail(details);
        }, true);
    }

    #readInput(event) {
        const target = event.target;
        const path = target.dataset.setting;
        if (path) {
            let value = target.type === 'checkbox' ? target.checked : target.value;
            if (target.type === 'number') value = Number(value);
            writePath(this.settings, path, value);
            if (event.type === 'change' && path === 'image.bizyair.templateLibrary.activeId') {
                this.#applySelectedBizyAirTemplate();
                this.renderModal();
                this.#changed(true);
                return;
            }
            this.#changed(event.type === 'change');
            if (event.type === 'change' && path.endsWith('.api.mode')) {
                this.renderModal();
            }
            return;
        }

        if (target.classList.contains('ttbm-character-prompt')) {
            const info = this.#currentCharacterInfo();
            const prompts = this.#characterPromptSettings();
            const previous = prompts.records[info.key] || {};
            prompts.records[info.key] = {
                ...previous,
                key: info.key,
                label: info.label,
                kind: info.kind,
                characterId: info.characterId,
                fileName: info.fileName,
                prompt: target.value,
                updatedAt: new Date().toISOString()
            };
            this.#changed(event.type === 'change');
            return;
        }

        const card = target.closest('[data-list-path][data-index]');
        if (!card) return;
        const list = readPath(this.settings, card.dataset.listPath);
        const item = list[Number(card.dataset.index)];
        if (!item) return;

        if (target.classList.contains('ttbm-entry-title')) item.title = target.value;
        if (target.classList.contains('ttbm-entry-role')) item.role = target.value;
        if (target.classList.contains('ttbm-entry-enabled')) item.enabled = target.checked;
        if (target.classList.contains('ttbm-entry-content')) item.content = target.value;
        if (target.classList.contains('ttbm-rule-name')) item.name = target.value;
        if (target.classList.contains('ttbm-rule-flags')) item.flags = target.value;
        if (target.classList.contains('ttbm-rule-enabled')) item.enabled = target.checked;
        if (target.classList.contains('ttbm-rule-pattern')) item.pattern = target.value;
        if (target.classList.contains('ttbm-rule-replacement')) item.replacement = target.value;
        this.#changed(event.type === 'change');
    }

    #changed(apply = false) {
        this.onSettingsChanged(this.settings, { apply });
    }

    open() {
        document.documentElement.classList.add('ttbm-modal-open');
        document.body.classList.add('ttbm-modal-open');
        document.getElementById('ttbm-modal').hidden = false;
        this.renderModal();
    }

    close() {
        document.getElementById('ttbm-modal').hidden = true;
        document.documentElement.classList.remove('ttbm-modal-open');
        document.body.classList.remove('ttbm-modal-open');
        this.#changed(true);
    }

    renderModal() {
        const body = document.getElementById('ttbm-modal-body');
        if (!body) return;
        document.querySelectorAll('#ttbm-modal [data-tab]').forEach(button => button.classList.toggle('ttbm-active', button.dataset.tab === this.modalTab));
        if (this.modalTab === 'memory') body.innerHTML = this.#memoryHtml();
        if (this.modalTab === 'status') body.innerHTML = this.#statusHtml();
        if (this.modalTab === 'image') body.innerHTML = this.#imageHtml();
        if (this.modalTab === 'runtime') body.innerHTML = this.#runtimeHtml();
        if (this.modalTab === 'monitor') body.innerHTML = this.#monitorHtml();
    }

    #memoryHtml() {
        const memory = this.settings.memory;
        return `
            <section class="ttbm-section">
                <div class="ttbm-grid ttbm-grid-5">
                    <label class="ttbm-check"><input type="checkbox" data-setting="memory.enabled" ${memory.enabled ? 'checked' : ''}>启用记忆</label>
                    ${numberField('小总结每 N 楼', 'memory.smallEvery', memory.smallEvery, 1)}
                    ${numberField('小总结额外读取 K 楼', 'memory.smallContextExtraFloors', memory.smallContextExtraFloors || 0, 0)}
                    ${numberField('大总结每 N 楼', 'memory.largeEvery', memory.largeEvery, 1)}
                    ${numberField('保留最近 N 楼不处理', 'memory.reserveFloors', memory.reserveFloors, 0)}
                    ${numberField('每轮最多记忆调用', 'memory.maxCallsPerTurn', memory.maxCallsPerTurn, 0, 20)}
                    ${numberField('单次最大输出 tokens', 'memory.responseLength', memory.responseLength, 32, 32000)}
                </div>
                <p class="ttbm-hint">大总结为累计叠层；主对话只注入最新大总结和其后的阶段小总结。修改提示词或正则会自动形成新配方，不会误用旧结果。</p>
            </section>
            ${this.#apiSection('记忆模型连接', 'memory.api', memory.api)}
            ${this.#regexSection('记忆输入正则', 'memory.inputRegex', memory.inputRegex, '先处理被送入模型的聊天文本。')}
            ${this.#promptSection('小总结提示词条目栈', 'memory.smallPromptEntries', memory.smallPromptEntries)}
            ${this.#promptSection('大总结提示词条目栈', 'memory.largePromptEntries', memory.largePromptEntries)}
            ${this.#regexSection('记忆输出正则', 'memory.outputRegex', memory.outputRegex, '模型返回后按顺序替换，再保存摘要。')}
            <section class="ttbm-section">
                <h3>主对话记忆注入</h3>
                <div class="ttbm-grid">
                    <label class="ttbm-check"><input type="checkbox" data-setting="memory.injection.enabled" ${memory.injection.enabled ? 'checked' : ''}>启用注入</label>
                    <label>位置<select class="text_pole" data-setting="memory.injection.position">
                        ${option('in_chat', '聊天内指定深度', memory.injection.position)}
                        ${option('in_prompt', '故事字符串之后', memory.injection.position)}
                        ${option('before_prompt', '故事字符串之前', memory.injection.position)}
                    </select></label>
                    ${numberField('深度', 'memory.injection.depth', memory.injection.depth, 0, 100)}
                    <label>角色<select class="text_pole" data-setting="memory.injection.role">
                        ${option('system', 'system', memory.injection.role)}
                        ${option('user', 'user', memory.injection.role)}
                        ${option('assistant', 'assistant', memory.injection.role)}
                    </select></label>
                </div>
                <label>注入模板<textarea class="text_pole" rows="8" data-setting="memory.injection.template">${escapeHtml(memory.injection.template)}</textarea></label>
                <p class="ttbm-hint">可用：{{large_memory}}、{{small_memory}}、{{memory}}</p>
            </section>
        `;
    }

    #statusHtml() {
        const status = this.settings.status;
        return `
            <section class="ttbm-section">
                <div class="ttbm-grid">
                    <label class="ttbm-check"><input type="checkbox" data-setting="status.enabled" ${status.enabled ? 'checked' : ''}>每次 AI 输出后独立更新</label>
                    ${numberField('读取最近 N 个用户楼层', 'status.contextFloors', status.contextFloors, 1, 1000)}
                    ${numberField('单次最大输出 tokens', 'status.responseLength', status.responseLength, 32, 32000)}
                    ${numberField('显示深度（0 = 最后一条消息后）', 'status.renderDepth', status.renderDepth, 0, 100000)}
                    <label class="ttbm-check"><input type="checkbox" data-setting="status.renderAsHtml" ${status.renderAsHtml ? 'checked' : ''}>把状态输出按 HTML 渲染</label>
                </div>
                <p class="ttbm-hint">状态栏只在一轮 AI 回复完成后调用。显示深度按当前已加载消息从末尾倒数：0 在最后，1 插在最后一条消息前。开启 HTML 渲染意味着你信任自己的提示词和模型输出。</p>
            </section>
            ${this.#apiSection('状态栏模型连接', 'status.api', status.api)}
            ${this.#regexSection('状态栏输入正则', 'status.inputRegex', status.inputRegex, '先处理最近对话，再交给状态栏模型调用。')}
            ${this.#promptSection('状态栏提示词条目栈', 'status.promptEntries', status.promptEntries)}
            ${this.#regexSection('状态栏渲染输出正则', 'status.outputRegex', status.outputRegex, '直接处理状态模型原始输出，仅用于界面渲染。')}
            <section class="ttbm-section">
                <h3>正文生成状态注入</h3>
                <div class="ttbm-grid">
                    <label class="ttbm-check"><input type="checkbox" data-setting="status.injection.enabled" ${status.injection.enabled ? 'checked' : ''}>注入下一轮正文生成</label>
                    <label>位置<select class="text_pole" data-setting="status.injection.position">
                        ${option('in_chat', '聊天内指定深度', status.injection.position)}
                        ${option('in_prompt', '故事字符串之后', status.injection.position)}
                        ${option('before_prompt', '故事字符串之前', status.injection.position)}
                    </select></label>
                    ${numberField('深度', 'status.injection.depth', status.injection.depth, 0, 100)}
                    <label>角色<select class="text_pole" data-setting="status.injection.role">
                        ${option('system', 'system', status.injection.role)}
                        ${option('user', 'user', status.injection.role)}
                        ${option('assistant', 'assistant', status.injection.role)}
                    </select></label>
                </div>
                <label>注入模板<textarea class="text_pole" rows="7" data-setting="status.injection.template">${escapeHtml(status.injection.template)}</textarea></label>
                <p class="ttbm-hint">模板宏：{{status}}。这里读取状态模型的原始输出，不会复用上方渲染正则的处理结果。</p>
            </section>
            ${this.#regexSection('正文注入输出正则', 'status.injection.outputRegex', status.injection.outputRegex, '直接处理状态模型原始输出，仅用于送入下一轮正文生成。')}
            <section class="ttbm-section">
                <h3>状态栏渲染</h3>
                <label>HTML 模板<textarea class="text_pole" rows="7" data-setting="status.htmlTemplate">${escapeHtml(status.htmlTemplate)}</textarea></label>
                <p class="ttbm-hint">模板宏：{{status}}</p>
                <label>自定义 CSS<textarea class="text_pole ttbm-code" rows="12" data-setting="status.css">${escapeHtml(status.css)}</textarea></label>
            </section>
        `;
    }

    #runtimeHtml() {
        const stats = this.stats;
        return `
            <section class="ttbm-section">
                <h3>当前分支</h3>
                ${stats ? `
                    <dl class="ttbm-stats">
                        <dt>用户楼层</dt><dd>${stats.totalFloors}</dd>
                        <dt>可总结到</dt><dd>${stats.eligibleFloor}</dd>
                        <dt>已匹配小总结</dt><dd>${stats.smallCount}</dd>
                        <dt>已匹配大总结</dt><dd>${stats.largeCount}</dd>
                        <dt>最近图片楼层</dt><dd>${stats.imageFloor || '-'}</dd>
                        <dt>最近图片数量</dt><dd>${stats.imageCount || '-'}</dd>
                        <dt>当前分支链</dt><dd><code>${escapeHtml(stats.chain)}</code></dd>
                        <dt>最后刷新</dt><dd>${escapeHtml(stats.updatedAt || '')}</dd>
                    </dl>
                ` : '<p>尚未读取当前聊天。</p>'}
                ${stats?.lastError ? `<div class="ttbm-error">${escapeHtml(stats.lastError)}</div>` : ''}
                <button id="ttbm-runtime-run" class="menu_button" type="button">立即执行记忆、状态栏与图片</button>
            </section>
            <section class="ttbm-section">
                <h3>分支复用说明</h3>
                <p>每条消息都会进入一条累计链指纹。分支前的消息链完全相同，因此旧摘要可以直接命中；分叉后的链会改变，只重算受影响的阶段。聊天文件名和当前绝对楼层不会被当成唯一依据。</p>
            </section>
        `;
    }

    #imageHtml() {
        const image = this.settings.image;
        const library = this.#bizyairTemplateLibrary();
        const currentTemplate = this.#selectedBizyAirTemplate();
        const templateOptions = library.items.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === library.activeId ? 'selected' : ''}>${escapeHtml(item.name || item.id)}</option>`).join('');
        return `
            <section class="ttbm-section">
                <div class="ttbm-grid">
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.enabled" ${image.enabled ? 'checked' : ''}>启用图片模块</label>
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.autoGenerate" ${image.autoGenerate ? 'checked' : ''}>AI 回复完成后自动规划并生成</label>
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.cacheAsDataUrl" ${image.cacheAsDataUrl !== false ? 'checked' : ''}>把图片缓存为 data URL</label>
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.debugNotifications" ${image.debugNotifications ? 'checked' : ''}>测试模式通知</label>
                    ${numberField('读取最近 N 个用户楼层', 'image.contextFloors', image.contextFloors, 1, 1000)}
                    ${numberField('规划最大图片数（1-3）', 'image.maxImagesPerMessage', image.maxImagesPerMessage, 1, 3)}
                    ${numberField('规划输出 tokens', 'image.responseLength', image.responseLength, 32, 32000)}
                </div>
                <p class="ttbm-hint">图片模块独立于记忆和状态栏。它只在 AI 回复完成后生成；已有缓存会按楼层链指纹回填到历史消息对应位置，不会因为当前不在最后一层就失效。</p>
            </section>
            ${this.#apiSection('图片规划模型连接', 'image.api', image.api)}
            ${this.#characterPromptHtml()}
            ${this.#regexSection('正文提取正则', 'image.inputRegex', image.inputRegex, '先从 AI 回复中提取/清洗需要规划插图的正文，再交给图片规划模型。')}
            ${this.#promptSection('图片规划提示词条目栈', 'image.promptEntries', image.promptEntries)}
            <section class="ttbm-section">
                <h3>图片规划 XML 标签</h3>
                <div class="ttbm-grid">
                    <label>插入位置标签<input class="text_pole" data-setting="image.positionTag" value="${escapeHtml(image.positionTag || 'position')}" placeholder="position"></label>
                    <label>正面提示词标签<input class="text_pole" data-setting="image.promptTag" value="${escapeHtml(image.promptTag || 'positive_prompt')}" placeholder="positive_prompt"></label>
                </div>
                <p class="ttbm-hint">程序会把正文切成带序号的 <code>&lt;segment id="..."&gt;</code> 分片并注册为 <code>{{body_segments}}</code>。规划模型只需要输出这两个标签：位置标签填分片序号，正面提示词标签填 BizyAir prompt。</p>
            </section>
            <section class="ttbm-section">
                <h3>BizyAir API</h3>
                <div class="ttbm-grid">
                    <label>已保存模板<select class="text_pole" data-setting="image.bizyair.templateLibrary.activeId">
                        ${templateOptions || '<option value="">暂无模板</option>'}
                    </select></label>
                    <label>新模板名称<input class="text_pole" data-setting="image.bizyair.templateLibrary.importName" value="${escapeHtml(library.importName || '')}" placeholder="例如：竖图工作流 / 51978"></label>
                    <label class="ttbm-check"><button class="menu_button" type="button" data-bizyair-template-action="delete">删除当前模板</button></label>
                </div>
                <p class="ttbm-hint">切换模板会立刻应用该模板保存的 Web App ID、input_values 和示例中能对应到插件控件的参数。当前模板可调字段：${escapeHtml(this.#templateControlsText(currentTemplate))}</p>
                <label>粘贴 BizyAir API 示例代码<textarea class="text_pole ttbm-code" rows="10" data-setting="image.bizyair.templateLibrary.exampleCode" placeholder="粘贴 fetch('https://api.bizyair.cn/.../create', { body: JSON.stringify(...) }) 示例">${escapeHtml(library.exampleCode || '')}</textarea></label>
                <div class="ttbm-card-actions">
                    <button class="menu_button" type="button" data-bizyair-template-action="parse-save">解析并保存为模板</button>
                </div>
                <p class="ttbm-hint">解析器会读取 <code>web_app_id</code>、<code>suppress_preview_output</code> 和 <code>input_values</code>。seed、steps、width、height、cfg、sampler、scheduler、denoise、正面/负面提示词这些能对应控件的字段会同步到设置；其它字段保留为模板固定值。</p>
                <div class="ttbm-grid">
                    ${numberField('Web App ID', 'image.bizyair.webAppId', image.bizyair.webAppId, 1, 1000000)}
                    ${numberField('宽度', 'image.bizyair.width', image.bizyair.width, 64, 4096)}
                    ${numberField('高度', 'image.bizyair.height', image.bizyair.height, 64, 4096)}
                    ${numberField('Steps', 'image.bizyair.steps', image.bizyair.steps, 1, 200)}
                    ${numberField('Seed', 'image.bizyair.seed', image.bizyair.seed, 1, Number.MAX_SAFE_INTEGER)}
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.bizyair.randomSeed" ${image.bizyair.randomSeed ? 'checked' : ''}>随机 seed</label>
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.bizyair.suppressPreviewOutput" ${image.bizyair.suppressPreviewOutput !== false ? 'checked' : ''}>suppress preview output</label>
                    ${numberField('轮询间隔 ms', 'image.bizyair.pollIntervalMs', image.bizyair.pollIntervalMs, 500, 30000)}
                    ${numberField('最大轮询次数', 'image.bizyair.maxPolls', image.bizyair.maxPolls, 1, 300)}
                    ${numberField('BizyAir 并发数', 'image.bizyair.concurrency', image.bizyair.concurrency || 3, 1, 8)}
                    <label>CFG<input class="text_pole" type="number" step="0.1" data-setting="image.bizyair.cfg" value="${escapeHtml(image.bizyair.cfg)}"></label>
                    <label>Denoise<input class="text_pole" type="number" step="0.01" data-setting="image.bizyair.denoise" value="${escapeHtml(image.bizyair.denoise)}"></label>
                    <label>Sampler<input class="text_pole" data-setting="image.bizyair.sampler" value="${escapeHtml(image.bizyair.sampler)}"></label>
                    <label>Scheduler<input class="text_pole" data-setting="image.bizyair.scheduler" value="${escapeHtml(image.bizyair.scheduler)}"></label>
                </div>
                <label>BizyAir API Key（可用逗号或换行填多个，当前版本使用第一个）<textarea class="text_pole ttbm-code" rows="3" data-setting="image.bizyair.apiKeys">${escapeHtml(image.bizyair.apiKeys)}</textarea></label>
                <label>正面提示词永久前缀<textarea class="text_pole ttbm-code" rows="5" data-setting="image.bizyair.positivePromptPrefix">${escapeHtml(image.bizyair.positivePromptPrefix || '')}</textarea></label>
                <label>负面提示词<textarea class="text_pole ttbm-code" rows="4" data-setting="image.bizyair.negativePrompt">${escapeHtml(image.bizyair.negativePrompt)}</textarea></label>
            </section>
        `;
    }

    #bizyairTemplateLibrary() {
        const bizyair = this.settings.image.bizyair;
        bizyair.templateLibrary ||= {};
        bizyair.templateLibrary.items ||= [];
        bizyair.templateLibrary.importName ||= '';
        bizyair.templateLibrary.exampleCode ||= '';
        if (!bizyair.templateLibrary.activeId && bizyair.templateLibrary.items.length) {
            bizyair.templateLibrary.activeId = bizyair.templateLibrary.items[0].id;
        }
        return bizyair.templateLibrary;
    }

    #selectedBizyAirTemplate() {
        const library = this.#bizyairTemplateLibrary();
        return library.items.find(item => item.id === library.activeId) || library.items[0] || null;
    }

    #applyBizyAirTemplate(template) {
        if (!template) return;
        const bizyair = this.settings.image.bizyair;
        if (template.webAppId !== null && template.webAppId !== undefined && Number.isFinite(Number(template.webAppId))) {
            bizyair.webAppId = Number(template.webAppId);
        }
        if (typeof template.suppressPreviewOutput === 'boolean') bizyair.suppressPreviewOutput = template.suppressPreviewOutput;
        if (template.inputValuesTemplate) bizyair.inputValuesTemplate = template.inputValuesTemplate;

        const controls = template.controls || {};
        for (const key of ['width', 'height', 'steps', 'seed', 'cfg', 'denoise']) {
            if (Object.prototype.hasOwnProperty.call(controls, key)) bizyair[key] = Number(controls[key]);
        }
        for (const key of ['sampler', 'scheduler', 'positivePromptPrefix', 'negativePrompt']) {
            if (Object.prototype.hasOwnProperty.call(controls, key)) bizyair[key] = String(controls[key] ?? '');
        }
        if (Object.prototype.hasOwnProperty.call(controls, 'randomSeed')) {
            bizyair.randomSeed = Boolean(controls.randomSeed);
        }
    }

    #applySelectedBizyAirTemplate() {
        this.#applyBizyAirTemplate(this.#selectedBizyAirTemplate());
    }

    #templateControlsText(template) {
        const keys = Object.keys(template?.controls || {});
        return keys.length ? keys.join('、') : '无，仅保留固定 input_values 字段';
    }

    #parseBizyAirTemplate() {
        try {
            const library = this.#bizyairTemplateLibrary();
            const parsed = parseBizyAirApiExample(library.exampleCode);
            const id = uniqueId('bizyair-template');
            const name = String(library.importName || '').trim()
                || `BizyAir ${parsed.webAppId || '模板'} ${library.items.length + 1}`;
            const template = {
                id,
                name,
                webAppId: parsed.webAppId,
                suppressPreviewOutput: parsed.suppressPreviewOutput,
                inputValuesTemplate: parsed.inputValuesTemplate,
                controls: parsed.controls,
                fixedKeys: parsed.fixedKeys,
                createdAt: new Date().toISOString()
            };
            library.items.push(template);
            library.activeId = id;
            library.importName = '';
            this.#applyBizyAirTemplate(template);
            this.renderModal();
            this.#changed(true);
            globalThis.toastr?.success?.(`已保存 BizyAir 模板：${name}`);
        } catch (error) {
            this.showError(error);
        }
    }

    #deleteBizyAirTemplate() {
        const library = this.#bizyairTemplateLibrary();
        if (!library.items.length) return;
        const index = library.items.findIndex(item => item.id === library.activeId);
        if (index < 0) return;
        if (library.items.length <= 1) {
            this.showError(new Error('至少保留一个 BizyAir 模板。'));
            return;
        }
        library.items.splice(index, 1);
        library.activeId = library.items[Math.max(0, index - 1)]?.id || library.items[0]?.id || '';
        this.#applySelectedBizyAirTemplate();
        this.renderModal();
        this.#changed(true);
    }

    #currentCharacterInfo() {
        const info = this.getCurrentCharacterInfo?.() || {};
        return {
            kind: String(info.kind || 'unknown'),
            key: String(info.key || 'unknown'),
            label: String(info.label || '当前聊天'),
            characterId: String(info.characterId || ''),
            fileName: String(info.fileName || '')
        };
    }

    #characterPromptSettings() {
        this.settings.image.characterPrompts ||= {};
        this.settings.image.characterPrompts.records ||= {};
        this.settings.image.characterPrompts.fallback ||= '';
        return this.settings.image.characterPrompts;
    }

    #characterPromptHtml() {
        const info = this.#currentCharacterInfo();
        const prompts = this.#characterPromptSettings();
        const record = prompts.records[info.key] || {};
        const savedCount = Object.keys(prompts.records).length;
        return `
            <section class="ttbm-section">
                <h3>角色外貌提示词</h3>
                <p class="ttbm-hint">当前角色：<strong>${escapeHtml(info.label)}</strong> <code>${escapeHtml(info.key)}</code>。这里保存的是当前角色的外貌/画风写法实例；切换角色后会自动加载对应角色的文本。</p>
                <label>当前角色外貌提示词<textarea class="text_pole ttbm-code ttbm-character-prompt" rows="8">${escapeHtml(record.prompt || '')}</textarea></label>
                <label>默认外貌提示词（当前角色未填写时使用）<textarea class="text_pole ttbm-code" rows="5" data-setting="image.characterPrompts.fallback">${escapeHtml(prompts.fallback || '')}</textarea></label>
                <p class="ttbm-hint">图片规划提示词可用宏：{{character_prompt}}、{{appearance_prompt}}、{{character_name}}、{{character_key}}、{{character_id}}、{{character_file}}。已保存 ${savedCount} 个角色档案。</p>
            </section>
        `;
    }

    #monitorHtml() {
        const state = this.monitorState;
        return `
            <section class="ttbm-section ttbm-monitor-head">
                <div class="ttbm-section-head">
                    <h3>全局调用监控</h3>
                    <span id="ttbm-monitor-state" class="ttbm-monitor-state ${state.active ? 'ttbm-monitor-live' : ''}">${state.active ? '记录中' : '已暂停'} · ${state.records.length}/${state.maxEvents}</span>
                </div>
                <div class="ttbm-card-actions ttbm-monitor-actions">
                    <button class="menu_button" type="button" data-monitor-action="toggle">${state.active ? '暂停监控' : '继续监控'}</button>
                    <button class="menu_button" type="button" data-monitor-action="clear">清空</button>
                    <button class="menu_button" type="button" data-monitor-action="expand">全部展开</button>
                    <button class="menu_button" type="button" data-monitor-action="collapse">全部收起</button>
                </div>
                <p class="ttbm-hint">同时记录生成生命周期、最终 prompt/采样参数以及底层 fetch/XHR 请求与响应。Authorization、API Key、token、password、secret、cookie 等字段会递归脱敏。流式响应只记录请求与响应头，正文由生成事件反映。</p>
            </section>
            <section id="ttbm-monitor-list" class="ttbm-monitor-list">
                ${state.records.map(monitorRecordHtml).join('') || '<p class="ttbm-hint">尚无事件。保持监控开启后执行正文生成或插件调用。</p>'}
            </section>
        `;
    }

    #promptSection(title, path, entries) {
        return `
            <section class="ttbm-section">
                <div class="ttbm-section-head"><h3>${title}</h3><button class="menu_button" type="button" data-add-entry="${path}">新增条目</button></div>
                <p class="ttbm-hint">按从上到下的顺序发送。常用宏：{{chat}}、{{summary_chat}}、{{context_chat}}、{{extra_chat}}、{{small_extra_floors}}、{{body}}、{{body_segments}}、{{segmented_body}}、{{source_segments}}、{{assistant}}、{{floor}}、{{floor_start}}、{{floor_end}}、{{summary_floor_start}}、{{summary_floor_end}}、{{context_floor_start}}、{{context_floor_end}}、{{extra_floor_start}}、{{extra_floor_end}}、{{total_floors}}、{{eligible_floor}}、{{previous_large}}、{{small_summaries}}、{{memory}}、{{status}}、{{previous_status}}、{{status_raw}}、{{status_injection}}、{{last_user}}、{{last_assistant}}、{{max_images}}、{{position_tag}}、{{prompt_tag}}、{{character_prompt}}、{{appearance_prompt}}、{{character_name}}、{{character_key}}、{{character_id}}、{{character_file}}</p>
                <div class="ttbm-list">${promptEntriesHtml(entries, path)}</div>
            </section>
        `;
    }

    #apiSection(title, path, config) {
        const profiles = this.getConnectionProfiles();
        const profileOptions = profiles.map(profile => {
            const selected = profile.id === config.connectionProfileId ? 'selected' : '';
            const detail = [profile.api, profile.model].filter(Boolean).join(' / ');
            return `<option value="${escapeHtml(profile.id)}" ${selected}>${escapeHtml(profile.name)}${detail ? ` · ${escapeHtml(detail)}` : ''}</option>`;
        }).join('');
        return `
            <section class="ttbm-section">
                <h3>${title}</h3>
                <div class="ttbm-grid">
                    <label>调用来源<select class="text_pole" data-setting="${path}.mode">
                        ${option('current', '沿用当前聊天 API', config.mode)}
                        ${option('connection_profile', '独立 Connection Manager 配置', config.mode)}
                    </select></label>
                    <label>独立连接配置<select class="text_pole" data-setting="${path}.connectionProfileId" ${config.mode === 'connection_profile' ? '' : 'disabled'}>
                        <option value="">请选择 Chat Completion 配置</option>
                        ${profileOptions}
                    </select></label>
                    <label class="ttbm-check"><input type="checkbox" data-setting="${path}.includePreset" ${config.includePreset !== false ? 'checked' : ''}>应用该连接配置的采样预设</label>
                </div>
                <p class="ttbm-hint">独立模式复用 Connection Manager 中保存的 Chat Completion 配置和密钥。记忆、状态栏和图片规划可以选择不同配置，插件不会保存这些模型 API Key。</p>
                ${profiles.length ? '' : '<p class="ttbm-warning">当前没有可用的 Chat Completion Connection Profile，请先在 Connection Manager 中创建。</p>'}
            </section>
        `;
    }

    #regexSection(title, path, rules, hint) {
        return `
            <section class="ttbm-section">
                <div class="ttbm-section-head"><h3>${title}</h3><button class="menu_button" type="button" data-add-rule="${path}">新增正则</button></div>
                <p class="ttbm-hint">${hint} 规则按从上到下执行，语法为 JavaScript RegExp。</p>
                <div class="ttbm-list">${regexRulesHtml(rules, path)}</div>
            </section>
        `;
    }

    updateStats(stats) {
        this.stats = { ...(this.stats || {}), ...stats };
        if (this.modalTab === 'runtime' && !document.getElementById('ttbm-modal').hidden) this.renderModal();
    }

    updateMonitor(state) {
        this.monitorState = state;
        const modal = document.getElementById('ttbm-modal');
        if (this.modalTab !== 'monitor' || !modal || modal.hidden) return;
        if (state.cleared) {
            this.renderModal();
            return;
        }
        const status = document.getElementById('ttbm-monitor-state');
        if (status) {
            status.textContent = `${state.active ? '记录中' : '已暂停'} · ${state.records.length}/${state.maxEvents}`;
            status.classList.toggle('ttbm-monitor-live', state.active);
        }
        if (!state.record) return;
        const list = document.getElementById('ttbm-monitor-list');
        if (!list) return;
        if (!list.querySelector('[data-monitor-id]')) list.innerHTML = '';
        list.insertAdjacentHTML('beforeend', monitorRecordHtml(state.record));
        while (list.querySelectorAll('[data-monitor-id]').length > state.maxEvents) {
            list.querySelector('[data-monitor-id]')?.remove();
        }
    }

    #populateMonitorDetail(details) {
        const pre = details.querySelector('.ttbm-monitor-json');
        if (!pre || pre.dataset.loaded === 'true') return;
        const record = this.monitor?.getRecord(details.dataset.monitorId);
        pre.textContent = record ? JSON.stringify(record.details, null, 2) : '事件已从内存队列中移除。';
        pre.dataset.loaded = 'true';
    }

    showError(error) {
        this.stats = { ...(this.stats || {}), lastError: error?.message || String(error) };
        globalThis.toastr?.error?.(`Branch Memory：${this.stats.lastError}`);
        if (this.modalTab === 'runtime' && !document.getElementById('ttbm-modal').hidden) this.renderModal();
    }

    ensureStatusPosition() {
        const chat = document.getElementById('chat');
        const host = document.getElementById('ttbm-status-host');
        if (!chat || !host) {
            return;
        }
        const messages = Array.from(chat.children).filter(element => element !== host && element.classList.contains('mes'));
        const insertionIndex = statusInsertionIndex(messages.length, this.settings.status.renderDepth);
        const before = messages[insertionIndex] || null;
        if (before) {
            if (host.parentElement !== chat || host.nextElementSibling !== before) {
                chat.insertBefore(host, before);
            }
        } else if (host.parentElement !== chat || chat.lastElementChild !== host) {
            chat.appendChild(host);
        }
    }

    renderStatus(content, statusSettings) {
        let host = document.getElementById('ttbm-status-host');
        const chat = document.getElementById('chat');
        if (!host) {
            host = document.createElement('div');
            host.id = 'ttbm-status-host';
            host.className = 'ttbm-status-flow-item';
        }
        if (chat && host.parentElement !== chat) chat.appendChild(host);
        this.ensureStatusPosition();

        let style = document.getElementById('ttbm-custom-status-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'ttbm-custom-status-style';
            document.head.appendChild(style);
        }
        style.textContent = statusSettings.css || '';

        if (!content || !statusSettings.enabled) {
            host.hidden = true;
            host.innerHTML = '';
            return;
        }
        const rendered = statusSettings.renderAsHtml ? content : escapeHtml(content);
        const markup = String(statusSettings.htmlTemplate || '{{status}}').replaceAll('{{status}}', rendered);
        host.innerHTML = statusSettings.renderAsHtml ? DOMPurify.sanitize(markup) : markup;
        host.hidden = false;
    }
}
