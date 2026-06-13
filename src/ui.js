import { escapeHtml, uniqueId } from './core.js';

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

export class SettingsUi {
    constructor({ settings, getConnectionProfiles = () => [], onSettingsChanged, onRunNow }) {
        this.settings = settings;
        this.getConnectionProfiles = getConnectionProfiles;
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
                    <b>Branch Memory & Status</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label"><input id="ttbm-master-enabled" type="checkbox">启用扩展</label>
                    <div class="ttbm-inline-actions">
                        <button id="ttbm-open-settings" class="menu_button" type="button">详细设置</button>
                        <button id="ttbm-run-now" class="menu_button" type="button">立即同步</button>
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
                        <div><strong>Branch Memory & Status</strong><small>分支感知的叠层记忆与独立状态栏</small></div>
                        <button class="menu_button" type="button" data-close-modal>关闭</button>
                    </header>
                    <nav class="ttbm-tabs">
                        <button class="menu_button" data-tab="memory" type="button">记忆模块</button>
                        <button class="menu_button" data-tab="status" type="button">状态栏模块</button>
                        <button class="menu_button" data-tab="runtime" type="button">运行状态</button>
                    </nav>
                    <div id="ttbm-modal-body" class="ttbm-modal-body"></div>
                </section>
            </div>
        `);
    }

    #bindEvents() {
        document.getElementById('ttbm-open-settings').addEventListener('click', () => this.open());
        document.getElementById('ttbm-run-now').addEventListener('click', () => this.onRunNow());
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
                this.renderModal();
            }

            if (event.target.closest('#ttbm-runtime-run')) {
                this.onRunNow();
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
    }

    #readInput(event) {
        const target = event.target;
        const path = target.dataset.setting;
        if (path) {
            let value = target.type === 'checkbox' ? target.checked : target.value;
            if (target.type === 'number') value = Number(value);
            writePath(this.settings, path, value);
            this.#changed(event.type === 'change');
            if (event.type === 'change' && path.endsWith('.api.mode')) {
                this.renderModal();
            }
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
        document.getElementById('ttbm-modal').hidden = false;
        this.renderModal();
    }

    close() {
        document.getElementById('ttbm-modal').hidden = true;
        this.#changed(true);
    }

    renderModal() {
        const body = document.getElementById('ttbm-modal-body');
        if (!body) return;
        document.querySelectorAll('#ttbm-modal [data-tab]').forEach(button => button.classList.toggle('ttbm-active', button.dataset.tab === this.modalTab));
        if (this.modalTab === 'memory') body.innerHTML = this.#memoryHtml();
        if (this.modalTab === 'status') body.innerHTML = this.#statusHtml();
        if (this.modalTab === 'runtime') body.innerHTML = this.#runtimeHtml();
    }

    #memoryHtml() {
        const memory = this.settings.memory;
        return `
            <section class="ttbm-section">
                <div class="ttbm-grid ttbm-grid-5">
                    <label class="ttbm-check"><input type="checkbox" data-setting="memory.enabled" ${memory.enabled ? 'checked' : ''}>启用记忆</label>
                    ${numberField('小总结每 N 楼', 'memory.smallEvery', memory.smallEvery, 1)}
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
                    <label class="ttbm-check"><input type="checkbox" data-setting="status.renderAsHtml" ${status.renderAsHtml ? 'checked' : ''}>把状态输出按 HTML 渲染</label>
                </div>
                <p class="ttbm-hint">状态栏调用与记忆调用完全分开。开启 HTML 渲染意味着你信任自己的提示词和模型输出。</p>
            </section>
            ${this.#apiSection('状态栏模型连接', 'status.api', status.api)}
            ${this.#regexSection('状态栏输入正则', 'status.inputRegex', status.inputRegex, '先处理最近对话，再交给状态栏模型调用。')}
            ${this.#promptSection('状态栏提示词条目栈', 'status.promptEntries', status.promptEntries)}
            ${this.#regexSection('状态栏输出正则', 'status.outputRegex', status.outputRegex, '处理模型输出后再渲染。')}
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
                        <dt>当前分支链</dt><dd><code>${escapeHtml(stats.chain)}</code></dd>
                        <dt>最后刷新</dt><dd>${escapeHtml(stats.updatedAt || '')}</dd>
                    </dl>
                ` : '<p>尚未读取当前聊天。</p>'}
                ${stats?.lastError ? `<div class="ttbm-error">${escapeHtml(stats.lastError)}</div>` : ''}
                <button id="ttbm-runtime-run" class="menu_button" type="button">立即执行记忆与状态栏</button>
            </section>
            <section class="ttbm-section">
                <h3>分支复用说明</h3>
                <p>每条消息都会进入一条累计链指纹。分支前的消息链完全相同，因此旧摘要可以直接命中；分叉后的链会改变，只重算受影响的阶段。聊天文件名和当前绝对楼层不会被当成唯一依据。</p>
            </section>
        `;
    }

    #promptSection(title, path, entries) {
        return `
            <section class="ttbm-section">
                <div class="ttbm-section-head"><h3>${title}</h3><button class="menu_button" type="button" data-add-entry="${path}">新增条目</button></div>
                <p class="ttbm-hint">按从上到下的顺序发送。可用宏：{{chat}}、{{floor_start}}、{{floor_end}}、{{total_floors}}、{{eligible_floor}}、{{previous_large}}、{{small_summaries}}、{{memory}}、{{previous_status}}、{{last_user}}、{{last_assistant}}</p>
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
                <p class="ttbm-hint">独立模式复用 Connection Manager 中保存的 Chat Completion 配置和密钥。记忆与状态栏可以选择不同配置，插件不会保存 API Key。</p>
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
        this.stats = stats;
        if (this.modalTab === 'runtime' && !document.getElementById('ttbm-modal').hidden) this.renderModal();
    }

    showError(error) {
        this.stats = { ...(this.stats || {}), lastError: error?.message || String(error) };
        globalThis.toastr?.error?.(`Branch Memory：${this.stats.lastError}`);
        if (this.modalTab === 'runtime' && !document.getElementById('ttbm-modal').hidden) this.renderModal();
    }

    ensureStatusAtChatEnd() {
        const chat = document.getElementById('chat');
        const host = document.getElementById('ttbm-status-host');
        if (chat && host && (host.parentElement !== chat || chat.lastElementChild !== host)) {
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
        if (chat && (host.parentElement !== chat || chat.lastElementChild !== host)) {
            chat.appendChild(host);
        }

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
        host.innerHTML = String(statusSettings.htmlTemplate || '{{status}}').replaceAll('{{status}}', rendered);
        host.hidden = false;
    }
}
