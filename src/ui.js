import { DOMPurify } from '/lib.js';
import { promptControlHtml } from './prompt-control-ui.js';
import { transformPrompt } from './prompt-control.js';
import { promptDetailHtml, promptRecordTitle, promptRecordVisible } from './prompt-inspector.js';
import { escapeHtml, statusInsertionIndex, uniqueId } from './core.js';

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

const PAGES = {
    memory: ['分支记忆', '设置总结频率与提示词，复用当前分支中仍然有效的历史总结。'],
    status: ['状态栏', '按楼层保存状态；切换已有回复时读取缓存，重新生成回复时更新状态。'],
    image: ['图片生成', '管理插图规划、角色外貌与 RunPod 连接。'],
    'prompt-control': ['提示词控制', '决定消息的归属、合并方式，以及哪些条目跳过处理。'],
    monitor: ['提示词查看', '从实际请求查看发送内容，按角色与消息逐层展开。'],
    runtime: ['运行状态', '查看当前分支的缓存命中、最近刷新和错误信息。']
};

function disclosure(key, title, description = '') {
    return `<details class="ttbm-section ttbm-disclosure" data-view-key="${escapeHtml(key)}">
        <summary><span><strong>${escapeHtml(title)}</strong>${description ? `<small>${escapeHtml(description)}</small>` : ''}</span></summary><div class="ttbm-disclosure-body">`;
}

function entrySummary(title, enabled, detail) {
    return `<summary class="ttbm-entry-summary"><span class="ttbm-entry-overview"><strong data-entry-name>${escapeHtml(title || '未命名')}</strong><small data-entry-detail>${escapeHtml(detail)}</small></span><span data-entry-state class="ttbm-badge ${enabled ? 'is-enabled' : ''}">${enabled ? '启用' : '停用'}</span></summary>`;
}

function promptEntriesHtml(entries, listPath) {
    return (entries || []).map((entry, index) => `
        <details class="ttbm-card ttbm-editor" data-view-key="${escapeHtml(`${listPath}/${entry.id || index}`)}" data-list-path="${listPath}" data-index="${index}">
            ${entrySummary(entry.title, entry.enabled, `${entry.role} · ${String(entry.content || '').length} 字符`)}
            <div class="ttbm-editor-body">
            <div class="ttbm-card-head">
                <label class="ttbm-grow">名称<input class="ttbm-entry-title text_pole" value="${escapeHtml(entry.title)}"></label>
                <label>角色<select class="ttbm-entry-role text_pole">
                    ${option('system', 'system', entry.role)}
                    ${option('user', 'user', entry.role)}
                    ${option('assistant', 'assistant', entry.role)}
                </select></label>
                <label class="ttbm-check"><input class="ttbm-entry-enabled" type="checkbox" ${entry.enabled ? 'checked' : ''}>启用</label>
            </div>
            <label>提示词内容<textarea class="ttbm-entry-content text_pole" rows="7">${escapeHtml(entry.content)}</textarea></label>
            <div class="ttbm-card-actions">
                <button class="menu_button ttbm-move-up" type="button">上移</button>
                <button class="menu_button ttbm-move-down" type="button">下移</button>
                <button class="menu_button ttbm-remove-entry" type="button">删除</button>
            </div>
            </div>
        </details>
    `).join('');
}

function regexRulesHtml(rules, listPath) {
    return (rules || []).map((rule, index) => `
        <details class="ttbm-card ttbm-regex-card ttbm-editor" data-view-key="${escapeHtml(`${listPath}/${rule.id || index}`)}" data-list-path="${listPath}" data-index="${index}">
            ${entrySummary(rule.name, rule.enabled, `/${rule.pattern || '未填写正则'}/${rule.flags || 'g'}`)}
            <div class="ttbm-editor-body">
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
            </div>
        </details>
    `).join('');
}

function numberField(label, path, value, min = 0, max = 100000) {
    return `<label>${label}<input class="text_pole" type="number" min="${min}" max="${max}" data-setting="${path}" value="${value}"></label>`;
}

function monitorRecordHtml(record) {
    const time = new Date(record.timestamp).toLocaleTimeString();
    return `
        <details class="ttbm-monitor-event ttbm-monitor-${escapeHtml(record.level)}" data-view-key="monitor/${escapeHtml(record.id)}" data-monitor-id="${escapeHtml(record.id)}">
            <summary>
                <time>${escapeHtml(time)}</time>
                <span class="ttbm-monitor-channel">${escapeHtml(record.channel)}</span>
                <strong>${escapeHtml(promptRecordTitle(record))}</strong>
            </summary>
            <div class="ttbm-monitor-detail">展开后读取提示词</div>
        </details>
    `;
}

export class SettingsUi {
    constructor({ settings, monitor, getConnectionProfiles = () => [], getCurrentCharacterInfo = () => null, onSettingsChanged, onImageGenerationToggle = () => {}, onRegenerateLatestImage = () => {}, onRunNow }) {
        this.settings = settings;
        this.monitor = monitor;
        this.monitorState = monitor?.snapshot() || { active: false, records: [], maxEvents: 300 };
        this.getConnectionProfiles = getConnectionProfiles;
        this.getCurrentCharacterInfo = getCurrentCharacterInfo;
        this.onSettingsChanged = onSettingsChanged;
        this.onImageGenerationToggle = onImageGenerationToggle;
        this.onRegenerateLatestImage = onRegenerateLatestImage;
        this.onRunNow = onRunNow;
        this.imageRegenerationBusy = false;
        this.stats = null;
        this.modalTab = 'memory';
        this.views = new Map();
        this.renderedTab = null;
        this.monitorFilter = this.monitor?.nativeLogs ? 'native' : 'requests';
    }

    mount() {
        this.#mountSettingsEntry();
        this.#mountWandImageToggle();
        this.#mountModal();
        this.#bindEvents();
        this.renderModal();
    }

    #mountWandImageToggle() {
        if (document.getElementById('ttbm-image-wand-container')) {
            this.#updateWandImageToggle();
            return;
        }
        const menu = document.getElementById('extensionsMenu');
        if (!menu) {
            if (this.wandMenuObserver) return;
            this.wandMenuObserver = new MutationObserver(() => {
                if (!document.getElementById('extensionsMenu')) return;
                this.wandMenuObserver?.disconnect();
                this.wandMenuObserver = null;
                this.#mountWandImageToggle();
            });
            this.wandMenuObserver.observe(document.body, { childList: true, subtree: true });
            return;
        }

        const container = document.createElement('div');
        container.id = 'ttbm-image-wand-container';
        container.className = 'extension_container';
        container.innerHTML = `
            <div id="ttbm-image-generation-toggle" class="list-group-item flex-container flexGap5 interactable" role="button" tabindex="0">
                <div class="extensionsMenuExtensionButton fa-solid" aria-hidden="true"></div>
                <span data-ttbm-image-toggle-label></span>
            </div>
            <div id="ttbm-image-regenerate-latest" class="list-group-item flex-container flexGap5 interactable" role="button" tabindex="0">
                <div class="extensionsMenuExtensionButton fa-solid fa-rotate" aria-hidden="true"></div>
                <span data-ttbm-image-regenerate-label>重新生图</span>
            </div>
        `;
        const attachmentContainer = document.getElementById('attach_file_wand_container');
        if (attachmentContainer?.parentElement === menu) attachmentContainer.insertAdjacentElement('afterend', container);
        else menu.prepend(container);

        const toggle = container.querySelector('#ttbm-image-generation-toggle');
        const activate = (event) => {
            if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            if (!this.settings.enabled) {
                globalThis.toastr?.warning?.('扩展总开关已关闭，请先在扩展设置中启用。');
                return;
            }
            const paused = Boolean(this.settings.image.enabled) && !Boolean(this.settings.image.paused);
            this.settings.image.enabled = true;
            this.settings.image.paused = paused;
            this.onImageGenerationToggle(paused);
            this.#changed(true);
            this.#updateWandImageToggle();
            this.renderModal();
            const message = paused ? '已暂停生图；当前任务已取消。' : '已启动生图。';
            globalThis.toastr?.[paused ? 'warning' : 'success']?.(message);
        };
        toggle.addEventListener('click', activate);
        toggle.addEventListener('keydown', activate);
        const regenerate = container.querySelector('#ttbm-image-regenerate-latest');
        const activateRegenerate = async (event) => {
            if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            if (this.imageRegenerationBusy) return;
            if (!this.settings.enabled) {
                globalThis.toastr?.warning?.('扩展总开关已关闭，请先在扩展设置中启用。');
                return;
            }
            if (!this.settings.image.enabled || this.settings.image.paused) {
                globalThis.toastr?.warning?.('生图当前已暂停，请先点击“启动生图”。');
                return;
            }
            this.imageRegenerationBusy = true;
            this.#updateWandImageToggle();
            globalThis.toastr?.info?.('正在清理最后一条 AI 消息的旧图并重新生图。');
            try {
                await this.onRegenerateLatestImage();
            } catch (error) {
                this.showError(error);
            } finally {
                this.imageRegenerationBusy = false;
                this.#updateWandImageToggle();
            }
        };
        regenerate.addEventListener('click', activateRegenerate);
        regenerate.addEventListener('keydown', activateRegenerate);
        this.#updateWandImageToggle();
    }

    #updateWandImageToggle() {
        const toggle = document.getElementById('ttbm-image-generation-toggle');
        if (!toggle) return;
        const paused = !Boolean(this.settings.enabled) || !Boolean(this.settings.image.enabled) || Boolean(this.settings.image.paused);
        const label = paused ? '启动生图' : '暂停生图';
        toggle.querySelector('[data-ttbm-image-toggle-label]').textContent = label;
        const icon = toggle.querySelector('.extensionsMenuExtensionButton');
        icon.classList.toggle('fa-circle-play', paused);
        icon.classList.toggle('fa-circle-pause', !paused);
        toggle.classList.toggle('ttbm-image-generation-paused', paused);
        toggle.setAttribute('aria-label', label);
        toggle.setAttribute('aria-pressed', String(paused));
        toggle.title = paused ? '恢复新的自动和手动生图请求' : '暂停新的生图请求，并取消当前 RunPod 队列';

        const regenerate = document.getElementById('ttbm-image-regenerate-latest');
        if (!regenerate) return;
        const unavailable = paused || this.imageRegenerationBusy;
        regenerate.classList.toggle('disabled', unavailable);
        regenerate.setAttribute('aria-disabled', String(unavailable));
        regenerate.setAttribute('aria-busy', String(this.imageRegenerationBusy));
        regenerate.tabIndex = unavailable ? -1 : 0;
        regenerate.querySelector('[data-ttbm-image-regenerate-label]').textContent = this.imageRegenerationBusy ? '重新生图中…' : '重新生图';
        regenerate.querySelector('.extensionsMenuExtensionButton')?.classList.toggle('fa-spin', this.imageRegenerationBusy);
        regenerate.title = paused
            ? '请先启动生图'
            : '清除最后一条 AI 消息的已有图片和缓存，再执行完整生图流程';
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
                        <button id="ttbm-open-monitor" class="menu_button" type="button">提示词查看</button>
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
                        <div><strong>Branch Memory</strong><small>记忆 · 状态 · 提示词 · 插图</small></div>
                        <button class="menu_button" type="button" data-close-modal>关闭</button>
                    </header>
                    <div class="ttbm-modal-layout"><nav class="ttbm-tabs" aria-label="设置页面">
                        <button class="menu_button" data-tab="memory" type="button">分支记忆</button>
                        <button class="menu_button" data-tab="status" type="button">状态栏</button>
                        <button class="menu_button" data-tab="image" type="button">图片生成</button>
                        <button class="menu_button" data-tab="prompt-control" type="button">提示词控制</button>
                        <button class="menu_button" data-tab="runtime" type="button">运行状态</button>
                        <button class="menu_button" data-tab="monitor" type="button">提示词查看</button>
                    </nav>
                    <div id="ttbm-modal-body" class="ttbm-modal-body" role="region" aria-labelledby="ttbm-page-title" tabindex="-1"></div></div>
                    <footer class="ttbm-modal-foot">设置更改后自动保存<span>Esc 关闭</span></footer>
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
            this.#updateWandImageToggle();
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

            if (event.target.closest('[data-add-control-rule]')) {
                this.settings.promptControl.rules.push({ id: uniqueId('control'), source: '*', contains: '', target: 'keep', enabled: true });
                this.renderModal();
                this.#changed(true);
            }
            const controlAction = event.target.closest('[data-control-action]')?.dataset.controlAction;
            if (controlAction) {
                const output = document.getElementById('ttbm-control-output');
                try {
                    const input = JSON.parse(document.getElementById('ttbm-control-input').value);
                    if (controlAction === 'preview') {
                        if (!Array.isArray(input)) throw new Error('请填入 messages JSON 数组');
                        output.textContent = JSON.stringify(transformPrompt(input, this.settings.promptControl, 'body'), null, 2);
                    } else {
                        if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('请填入脚本配置 JSON 对象');
                        const config = this.settings.promptControl;
                        for (const key of Object.keys(config.prefixes)) if (typeof input[key] === 'string') config.prefixes[key] = input[key];
                        for (const key of ['separator', 'separator_system']) if (typeof input[key] === 'string') config[key] = input[key];
                        this.#changed(true);
                        this.renderModal();
                        document.getElementById('ttbm-control-output').textContent = '已导入提示词格式配置。';
                    }
                } catch (error) { output.textContent = error.message; }
            }

            const addEntry = event.target.closest('[data-add-entry]');
            if (addEntry) {
                const list = readPath(this.settings, addEntry.dataset.addEntry);
                list.push({ id: uniqueId('prompt'), title: '新条目', enabled: true, role: 'user', content: '' });
                this.renderModal();
                this.#openNewEntry(addEntry.dataset.addEntry);
                this.#changed(true);
            }

            const addRule = event.target.closest('[data-add-rule]');
            if (addRule) {
                const list = readPath(this.settings, addRule.dataset.addRule);
                list.push({ id: uniqueId('regex'), name: '新正则', enabled: true, pattern: '', flags: 'g', replacement: '' });
                this.renderModal();
                this.#openNewEntry(addRule.dataset.addRule);
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

        modal.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
            if (event.key !== 'Tab') return;
            const focusable = [...modal.querySelectorAll('button, input, select, textarea, summary, [tabindex="0"]')]
                .filter(element => !element.disabled && element.getClientRects().length);
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
                event.preventDefault(); last?.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) {
                event.preventDefault(); first?.focus();
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
        if (target.id === 'ttbm-monitor-filter') {
            this.monitorFilter = target.value;
            this.renderModal();
            return;
        }
        const path = target.dataset.setting;
        if (path) {
            let value = target.type === 'checkbox' ? target.checked : target.value;
            if (target.type === 'number') value = Number(value);
            writePath(this.settings, path, value);
            if (event.type === 'change' && path === 'image.paused') {
                this.onImageGenerationToggle(Boolean(value));
                this.#updateWandImageToggle();
            }
            if (event.type === 'change' && path === 'image.enabled') this.#updateWandImageToggle();
            this.#changed(event.type === 'change');
            if (event.type === 'change' && (path.endsWith('.api.mode') || path.endsWith('.api.connectionProfileId'))) {
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
        if (target.dataset.controlField) {
            item[target.dataset.controlField] = target.type === 'checkbox' ? target.checked : target.value;
            this.#changed(event.type === 'change');
            return;
        }

        if (target.classList.contains('ttbm-entry-title')) item.title = target.value;
        if (target.classList.contains('ttbm-entry-role')) item.role = target.value;
        if (target.classList.contains('ttbm-entry-enabled')) item.enabled = target.checked;
        if (target.classList.contains('ttbm-entry-content')) item.content = target.value;
        if (target.classList.contains('ttbm-rule-name')) item.name = target.value;
        if (target.classList.contains('ttbm-rule-flags')) item.flags = target.value;
        if (target.classList.contains('ttbm-rule-enabled')) item.enabled = target.checked;
        if (target.classList.contains('ttbm-rule-pattern')) item.pattern = target.value;
        if (target.classList.contains('ttbm-rule-replacement')) item.replacement = target.value;
        const name = card.querySelector('[data-entry-name]');
        if (name) {
            name.textContent = item.title || item.name || '未命名';
            card.querySelector('[data-entry-detail]').textContent = item.role
                ? `${item.role} · ${String(item.content || '').length} 字符`
                : `/${item.pattern || '未填写正则'}/${item.flags || 'g'}`;
            const badge = card.querySelector('[data-entry-state]');
            badge.textContent = item.enabled ? '启用' : '停用';
            badge.classList.toggle('is-enabled', Boolean(item.enabled));
            if (!item.role) {
                const section = [...document.querySelectorAll('#ttbm-modal [data-view-key]')].find(el => el.dataset.viewKey === card.dataset.listPath);
                const count = section?.querySelector(':scope > summary small');
                if (count) count.textContent = `${list.filter(rule => rule.enabled).length} 条启用 / ${list.length} 条规则`;
            }
        }
        this.#changed(event.type === 'change');
    }

    #openNewEntry(path) {
        const cards = [...document.querySelectorAll('#ttbm-modal [data-list-path]')].filter(card => card.dataset.listPath === path);
        const card = cards.at(-1);
        if (!card) return;
        for (let parent = card; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
        card.querySelector('input')?.focus();
    }

    #changed(apply = false) {
        this.onSettingsChanged(this.settings, { apply });
    }

    open() {
        if (document.getElementById('ttbm-modal').hidden) this.returnFocus = document.activeElement;
        document.documentElement.classList.add('ttbm-modal-open');
        document.body.classList.add('ttbm-modal-open');
        document.getElementById('ttbm-modal').hidden = false;
        this.renderModal();
        document.querySelector('#ttbm-modal [data-close-modal].menu_button')?.focus();
    }

    close() {
        document.getElementById('ttbm-modal').hidden = true;
        document.documentElement.classList.remove('ttbm-modal-open');
        document.body.classList.remove('ttbm-modal-open');
        this.#changed(true);
        if (this.returnFocus?.isConnected) this.returnFocus.focus();
    }

    renderModal() {
        const body = document.getElementById('ttbm-modal-body');
        if (!body) return;
        const active = body.contains(document.activeElement) ? document.activeElement : null;
        const activePath = active?.dataset.setting;
        const activeCardKey = active?.closest('[data-view-key]')?.dataset.viewKey;
        const activeClass = active?.className;
        const activeId = active?.id;
        if (this.renderedTab) this.views.set(this.renderedTab, {
            scroll: body.scrollTop,
            details: new Map([...body.querySelectorAll('[data-view-key]')].map(el => [el.dataset.viewKey, el.open])),
            draft: body.querySelector('#ttbm-control-input')?.value,
            output: body.querySelector('#ttbm-control-output')?.textContent
        });
        const samePage = this.renderedTab === this.modalTab;
        document.querySelectorAll('#ttbm-modal [data-tab]').forEach(button => {
            const selected = button.dataset.tab === this.modalTab;
            button.classList.toggle('ttbm-active', selected);
            if (selected) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
        const content = {
            memory: () => this.#memoryHtml(), status: () => this.#statusHtml(), image: () => this.#imageHtml(),
            runtime: () => this.#runtimeHtml(), monitor: () => this.#monitorHtml(),
            'prompt-control': () => promptControlHtml(this.settings.promptControl)
        }[this.modalTab]();
        const [title, description] = PAGES[this.modalTab];
        body.innerHTML = `<header class="ttbm-page-head"><h2 id="ttbm-page-title">${title}</h2><p>${description}</p></header>${content}`;
        const view = this.views.get(this.modalTab);
        body.querySelectorAll('[data-view-key]').forEach(el => {
            if (view?.details.has(el.dataset.viewKey)) el.open = view.details.get(el.dataset.viewKey);
        });
        if (view?.draft !== undefined) body.querySelector('#ttbm-control-input').value = view.draft;
        if (view?.output !== undefined) body.querySelector('#ttbm-control-output').textContent = view.output;
        if (samePage && active) {
            const owner = [...body.querySelectorAll('[data-view-key]')].find(el => el.dataset.viewKey === activeCardKey);
            const replacement = activePath
                ? [...body.querySelectorAll('[data-setting]')].find(el => el.dataset.setting === activePath)
                : activeId ? document.getElementById(activeId)
                    : [...(owner?.querySelectorAll('button, input, select, textarea, summary') || [])].find(el => el.className === activeClass);
            (replacement || body).focus({ preventScroll: true });
        }
        body.scrollTop = view?.scroll || 0;
        this.renderedTab = this.modalTab;
    }

    #memoryHtml() {
        const memory = this.settings.memory;
        return `
            <section class="ttbm-section">
                <h3>常用设置</h3>
                <div class="ttbm-grid ttbm-grid-5">
                    <label class="ttbm-check"><input type="checkbox" data-setting="memory.enabled" ${memory.enabled ? 'checked' : ''}>启用记忆</label>
                    ${numberField('小总结每 N 楼', 'memory.smallEvery', memory.smallEvery, 1)}
                    ${numberField('大总结每 N 楼', 'memory.largeEvery', memory.largeEvery, 1)}
                    ${numberField('保留最近 N 楼不处理', 'memory.reserveFloors', memory.reserveFloors, 0)}
                    ${numberField('单次最大输出 tokens', 'memory.responseLength', memory.responseLength, 32, 32000)}
                </div>
                ${disclosure('memory.schedule', '高级调度', '参考楼层与每轮调用上限')}
                <div class="ttbm-grid">
                    ${numberField('小总结额外读取 K 楼', 'memory.smallContextExtraFloors', memory.smallContextExtraFloors || 0, 0)}
                    ${numberField('每轮最多记忆调用', 'memory.maxCallsPerTurn', memory.maxCallsPerTurn, 0, 20)}
                </div>
                <p class="ttbm-hint">额外 K 楼只作参考；修改这些参考楼层不会让已生成的总结失效。每轮调用上限设为 0 时只读取已有总结。</p>
                </div></details>
                <p class="ttbm-hint">大总结为累计叠层；主对话只注入最新大总结和其后的阶段小总结。修改提示词或正则会自动形成新配方，不会误用旧结果。</p>
            </section>
            ${this.#apiSection('记忆模型连接', 'memory.api', memory.api)}
            ${this.#regexSection('记忆输入正则', 'memory.inputRegex', memory.inputRegex, '先处理被送入模型的聊天文本。')}
            ${this.#promptSection('小总结提示词', 'memory.smallPromptEntries', memory.smallPromptEntries)}
            ${this.#promptSection('大总结提示词', 'memory.largePromptEntries', memory.largePromptEntries)}
            ${this.#regexSection('记忆输出正则', 'memory.outputRegex', memory.outputRegex, '模型返回后按顺序替换，再保存摘要。')}
            ${disclosure('memory.injection', '主对话记忆注入', '注入开关、位置与模板')}
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
            </div></details>
        `;
    }

    #statusHtml() {
        const status = this.settings.status;
        return `
            <section class="ttbm-section">
                <h3>常用设置</h3>
                <div class="ttbm-grid">
                    <label class="ttbm-check"><input type="checkbox" data-setting="status.enabled" ${status.enabled ? 'checked' : ''}>启用状态栏</label>
                    ${numberField('读取最近 N 个用户楼层', 'status.contextFloors', status.contextFloors, 1, 1000)}
                    ${numberField('单次最大输出 tokens', 'status.responseLength', status.responseLength, 32, 32000)}
                </div>
                <p class="ttbm-hint">切换已有的左右候选回复不会发起调用；重新生成整条回复会更新对应状态栏。</p>
            </section>
            ${this.#apiSection('状态栏模型连接', 'status.api', status.api)}
            ${this.#regexSection('状态栏输入正则', 'status.inputRegex', status.inputRegex, '先处理最近对话，再交给状态栏模型调用。')}
            ${this.#promptSection('状态栏提示词', 'status.promptEntries', status.promptEntries)}
            ${this.#regexSection('状态栏渲染输出正则', 'status.outputRegex', status.outputRegex, '直接处理状态模型原始输出，仅用于界面渲染。')}
            ${disclosure('status.injection', '正文生成状态注入', '下一轮正文读取哪些状态')}
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
            </div></details>
            ${this.#regexSection('正文注入输出正则', 'status.injection.outputRegex', status.injection.outputRegex, '直接处理状态模型原始输出，仅用于送入下一轮正文生成。')}
            ${disclosure('status.render', '状态栏渲染', '显示位置、HTML 模板与 CSS')}
                <div class="ttbm-grid">
                    ${numberField('显示深度（0 = 最后一条消息后）', 'status.renderDepth', status.renderDepth, 0, 100000)}
                    <label class="ttbm-check"><input type="checkbox" data-setting="status.renderAsHtml" ${status.renderAsHtml ? 'checked' : ''}>把状态输出按 HTML 渲染</label>
                </div>
                <p class="ttbm-hint">显示深度从末尾倒数，0 在最后。HTML 模式会渲染状态模型输出。</p>
                <label>HTML 模板<textarea class="text_pole" rows="7" data-setting="status.htmlTemplate">${escapeHtml(status.htmlTemplate)}</textarea></label>
                <p class="ttbm-hint">模板宏：{{status}}</p>
                <label>自定义 CSS<textarea class="text_pole ttbm-code" rows="12" data-setting="status.css">${escapeHtml(status.css)}</textarea></label>
            </div></details>
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
        const runpod = image.runpod;
        return `
            <section class="ttbm-section">
                <h3>常用设置</h3>
                <div class="ttbm-grid">
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.enabled" ${image.enabled ? 'checked' : ''}>启用图片模块</label>
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.paused" ${image.paused ? 'checked' : ''}>暂停生图（缓存图片仍显示）</label>
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.autoGenerate" ${image.autoGenerate ? 'checked' : ''}>AI 回复完成后自动规划并生成</label>
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.debugNotifications" ${image.debugNotifications ? 'checked' : ''}>测试模式通知</label>
                    ${numberField('读取最近 N 个用户楼层', 'image.contextFloors', image.contextFloors, 1, 1000)}
                    ${numberField('规划最大图片数（1-12）', 'image.maxImagesPerMessage', image.maxImagesPerMessage, 1, 12)}
                    ${numberField('规划输出 tokens', 'image.responseLength', image.responseLength, 32, 32000)}
                </div>
                <p class="ttbm-hint">实际计划达到 5 张时会在任何付费请求前要求确认，单条消息硬限制最多 12 张。所有成功图片都会以 data URL 保存到本地 Extension Store 90 天。</p>
            </section>
            ${this.#apiSection('图片规划模型连接', 'image.api', image.api)}
            ${this.#characterPromptHtml()}
            ${this.#regexSection('正文提取正则', 'image.inputRegex', image.inputRegex, '先从 AI 回复中提取/清洗需要规划插图的正文，再交给图片规划模型。')}
            ${this.#promptSection('图片规划提示词', 'image.promptEntries', image.promptEntries)}
            ${disclosure('image.xml', '图片规划 XML 标签', '插入位置与提示词标签')}
                <div class="ttbm-grid">
                    <label>插入位置标签<input class="text_pole" data-setting="image.positionTag" value="${escapeHtml(image.positionTag || 'position')}" placeholder="position"></label>
                    <label>正面提示词标签<input class="text_pole" data-setting="image.promptTag" value="${escapeHtml(image.promptTag || 'positive_prompt')}" placeholder="positive_prompt"></label>
                </div>
                <p class="ttbm-hint">程序会把正文切成带序号的 <code>&lt;segment id="..."&gt;</code> 分片。规划模型也可输出 <code>&lt;stop_image_generation&gt;原因&lt;/stop_image_generation&gt;</code>，停止错误或无意义正文的生图。</p>
            </div></details>
            ${disclosure('image.runpod', 'RunPod Serverless 生图 API', '连接信息、图像尺寸与生成参数')}
                <div class="ttbm-grid">
                    <label>API Base URL<input class="text_pole" data-setting="image.runpod.apiBase" value="${escapeHtml(runpod.apiBase || '')}" placeholder="https://api.runpod.ai/v2"></label>
                    <label>Endpoint ID<input class="text_pole" data-setting="image.runpod.endpointId" value="${escapeHtml(runpod.endpointId || '')}"></label>
                    ${numberField('宽度（512-1536，64 倍数）', 'image.runpod.width', runpod.width, 512, 1536)}
                    ${numberField('高度（512-1536，64 倍数）', 'image.runpod.height', runpod.height, 512, 1536)}
                    ${numberField('Seed', 'image.runpod.seed', runpod.seed, 0, Number.MAX_SAFE_INTEGER)}
                    <label class="ttbm-check"><input type="checkbox" data-setting="image.runpod.randomSeed" ${runpod.randomSeed ? 'checked' : ''}>随机 seed</label>
                    ${numberField('轮询间隔 ms', 'image.runpod.pollIntervalMs', runpod.pollIntervalMs, 500, 30000)}
                    ${numberField('最大轮询轮数', 'image.runpod.maxPolls', runpod.maxPolls, 1, 1800)}
                </div>
                <label>RunPod API Key<textarea class="text_pole ttbm-code" rows="2" data-setting="image.runpod.apiKey">${escapeHtml(runpod.apiKey || '')}</textarea></label>
                <label>正面提示词永久前缀<textarea class="text_pole ttbm-code" rows="5" data-setting="image.runpod.positivePromptPrefix">${escapeHtml(runpod.positivePromptPrefix || '')}</textarea></label>
                <p class="ttbm-hint">多个提示词会先连续提交到同一个 Endpoint 队列，再开始统一轮询。当前 Endpoint 的负面提示词固定在工作流中，API 暂不支持动态修改。</p>
            </div></details>
        `;
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
            ${disclosure('image.appearance', '角色外貌提示词', `当前角色：${info.label} · ${savedCount} 个外貌档案`)}
                <p class="ttbm-hint">保存当前角色的外貌和画风；切换角色后会自动加载对应文本。</p>
                <label>当前角色外貌提示词<textarea class="text_pole ttbm-code ttbm-character-prompt" rows="8">${escapeHtml(record.prompt || '')}</textarea></label>
                <label>默认外貌提示词（当前角色未填写时使用）<textarea class="text_pole ttbm-code" rows="5" data-setting="image.characterPrompts.fallback">${escapeHtml(prompts.fallback || '')}</textarea></label>
                <p class="ttbm-hint">图片规划提示词可用宏：{{character_prompt}}、{{appearance_prompt}}、{{character_name}}、{{character_key}}、{{character_id}}、{{character_file}}。</p>
            </div></details>
        `;
    }

    #monitorHtml() {
        const state = this.monitorState;
        return `
            <section class="ttbm-section ttbm-monitor-head">
                <div class="ttbm-section-head">
                    <h3>记录与筛选</h3>
                    <span id="ttbm-monitor-state" class="ttbm-monitor-state ${state.active ? 'ttbm-monitor-live' : ''}">${state.active ? '记录中' : '已暂停'} · ${state.records.length}/${state.maxEvents}</span>
                </div>
                <div class="ttbm-card-actions ttbm-monitor-actions">
                    <button class="menu_button" type="button" data-monitor-action="toggle">${state.active ? '暂停监控' : '继续监控'}</button>
                    <button class="menu_button" type="button" data-monitor-action="clear">清空</button>
                    <button class="menu_button" type="button" data-monitor-action="expand">全部展开</button>
                    <button class="menu_button" type="button" data-monitor-action="collapse">全部收起</button>
                </div>
                <label>查看层级<select id="ttbm-monitor-filter" class="text_pole">
                    ${option('native', '后端实际请求（TauriTavern 2.2）', this.monitorFilter)}
                    ${option('requests', '全部模型请求（含前端中间态）', this.monitorFilter)}
                    ${option('errors', '错误与告警', this.monitorFilter)}
                    ${option('all', '事件诊断', this.monitorFilter)}
                </select></label>
                <p id="ttbm-native-state" class="ttbm-hint">${this.#nativeStateText()}</p>
                <p class="ttbm-hint">按角色分组，编号保留发送顺序，长文本默认折叠。后端日志在调用完成后出现；展开时读取脱敏原文。</p>
            </section>
            <section id="ttbm-monitor-list" class="ttbm-monitor-list">
                ${state.records.filter(record => promptRecordVisible(record, this.monitorFilter)).slice().reverse().map(monitorRecordHtml).join('') || '<p class="ttbm-hint">这一层尚无记录；可切换层级，或保持监控开启后执行生成。</p>'}
            </section>
        `;
    }

    #promptSection(title, path, entries) {
        return `
            <section class="ttbm-section">
                <div class="ttbm-section-head"><h3>${title}</h3><button class="menu_button" type="button" data-add-entry="${path}">新增条目</button></div>
                <details class="ttbm-help" data-view-key="${path}/macros"><summary>可用宏与发送顺序</summary><p class="ttbm-hint">按从上到下的顺序发送。常用宏：{{chat}}、{{summary_chat}}、{{context_chat}}、{{extra_chat}}、{{small_extra_floors}}、{{body}}、{{body_segments}}、{{segmented_body}}、{{source_segments}}、{{assistant}}、{{floor}}、{{floor_start}}、{{floor_end}}、{{summary_floor_start}}、{{summary_floor_end}}、{{context_floor_start}}、{{context_floor_end}}、{{extra_floor_start}}、{{extra_floor_end}}、{{total_floors}}、{{eligible_floor}}、{{previous_large}}、{{small_summaries}}、{{memory}}、{{status}}、{{previous_status}}、{{status_raw}}、{{status_injection}}、{{last_user}}、{{last_assistant}}、{{max_images}}、{{position_tag}}、{{prompt_tag}}、{{character_prompt}}、{{appearance_prompt}}、{{character_name}}、{{character_key}}、{{character_id}}、{{character_file}}</p></details>
                <div class="ttbm-list">${promptEntriesHtml(entries, path) || '<p class="ttbm-empty">暂无提示词条目，点击“新增条目”开始配置。</p>'}</div>
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
            ${disclosure(path, title, config.mode === 'connection_profile' ? (profiles.find(profile => profile.id === config.connectionProfileId)?.name || '请选择独立连接') : '沿用当前聊天 API')}
                <div class="ttbm-grid">
                    <label>调用来源<select class="text_pole" data-setting="${path}.mode">
                        ${option('current', '沿用当前聊天 API', config.mode)}
                        ${option('connection_profile', '独立 Connection Manager 配置', config.mode)}
                    </select></label>
                    ${config.mode === 'connection_profile' ? `<label>独立连接配置<select class="text_pole" data-setting="${path}.connectionProfileId">
                        <option value="">请选择 Chat Completion 配置</option>
                        ${profileOptions}
                    </select></label>
                    <label class="ttbm-check"><input type="checkbox" data-setting="${path}.includePreset" ${config.includePreset !== false ? 'checked' : ''}>应用该连接配置的采样预设</label>` : ''}
                </div>
                <p class="ttbm-hint">独立模式复用 Connection Manager 中保存的 Chat Completion 配置和密钥。记忆、状态栏和图片规划可以选择不同配置，插件不会保存这些模型 API Key。</p>
                ${config.mode !== 'connection_profile' || profiles.length ? '' : '<p class="ttbm-warning">当前没有可用的 Chat Completion Connection Profile，请先在 Connection Manager 中创建。</p>'}
            </div></details>
        `;
    }

    #regexSection(title, path, rules, hint) {
        return `
            ${disclosure(path, title, `${(rules || []).filter(rule => rule.enabled).length} 条启用 / ${(rules || []).length} 条规则`)}
                <div class="ttbm-section-head"><span>按列表顺序处理</span><button class="menu_button" type="button" data-add-rule="${path}">新增正则</button></div>
                <p class="ttbm-hint">${hint} 规则按从上到下执行，语法为 JavaScript RegExp。</p>
                <div class="ttbm-list">${regexRulesHtml(rules, path) || '<p class="ttbm-empty">暂无正则，内容将直接通过。</p>'}</div>
            </div></details>
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
        const nativeState = document.getElementById('ttbm-native-state');
        if (nativeState) nativeState.textContent = this.#nativeStateText();
        if (!state.record || !promptRecordVisible(state.record, this.monitorFilter)) return;
        const list = document.getElementById('ttbm-monitor-list');
        if (!list) return;
        if (!list.querySelector('[data-monitor-id]')) list.innerHTML = '';
        list.insertAdjacentHTML('afterbegin', monitorRecordHtml(state.record));
        while (list.querySelectorAll('[data-monitor-id]').length > state.maxEvents) {
            list.querySelector('[data-monitor-id]:last-child')?.remove();
        }
    }

    #nativeStateText() {
        const state = this.monitorState.nativeState;
        return ({ connected: '已连接 TauriTavern 后端 LLM 日志。', connecting: '正在连接后端日志…',
            error: '后端日志读取失败；错误与告警中可查看原因。前端记录仍可用。',
            unavailable: '当前宿主未提供后端日志 API；这里只能确认前端提交内容。' })[state] || '打开监控后连接后端日志。';
    }

    async #populateMonitorDetail(details) {
        const container = details.querySelector('.ttbm-monitor-detail');
        if (!container || container.dataset.loaded) return;
        container.dataset.loaded = 'loading';
        container.textContent = '正在读取…';
        try {
            const record = await this.monitor?.loadRecord(details.dataset.monitorId);
            container.innerHTML = record ? promptDetailHtml(record, { prefixes: this.settings.promptControl.prefixes }) : '事件已从内存队列中移除。';
            container.dataset.loaded = 'true';
        } catch (error) {
            container.textContent = `读取失败：${error.message}。宿主日志可能已轮换；收起后展开可重试。`;
            delete container.dataset.loaded;
        }
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
