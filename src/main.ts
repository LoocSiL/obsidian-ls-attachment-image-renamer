import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, MarkdownView, getLinkpath } from 'obsidian';

interface LSRenamerSettings {
	template: string;
	indexDigits: number;
	multiNoteAction: 'skip' | 'rename_all' | 'copy';
	continuousNumbering: boolean;
	dateFormat: string;
	enableHash: boolean; 
}

const DEFAULT_SETTINGS: LSRenamerSettings = {
	template: '{{notename}}-{{index}}',
	indexDigits: 2,
	multiNoteAction: 'skip',
	continuousNumbering: true,
	dateFormat: 'YYYYMMDDHHmmss',
	enableHash: false 
}

class RenameTask {
	file: TFile;
	oldName: string;
	proposedName: string = '';
	proposedPath: string = '';
	linkedNotes: string[] = [];
	action: 'rename' | 'copy' | 'skip' | 'already_done' = 'rename';
	
	constructor(file: TFile) {
		this.file = file;
		this.oldName = file.name;
	}
}

interface FileToProcessData {
	file: TFile;
	linkedNotes: string[];
	hash: string;
}

interface FileState {
	data: FileToProcessData;
	userUnchecked: boolean;
}

export default class LSRenamerPlugin extends Plugin {
	settings!: LSRenamerSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'rename-linked-images',
			name: 'Rename images in current note',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					if (!checking) {
						void this.startRenameProcess(activeView);
					}
					return true;
				}
				return false;
			}
		});

		this.addSettingTab(new LSRenamerSettingTab(this.app, this));
	}

	async loadSettings() {
		const loadedData = await this.loadData() as Partial<LSRenamerSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData ?? {});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async startRenameProcess(view: MarkdownView) {
		const activeFile = view.file;
		if (!activeFile) return;

		const cache = this.app.metadataCache.getFileCache(activeFile);
		const linksAndEmbeds = [...(cache?.embeds || []), ...(cache?.links || [])];
		
		const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
		const filesToProcess = new Set<TFile>();

		for (const item of linksAndEmbeds) {
			const linkpath = getLinkpath(item.link);
			const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkpath, activeFile.path);
			
			if (targetFile instanceof TFile && imageExts.includes(targetFile.extension.toLowerCase())) {
				filesToProcess.add(targetFile);
			}
		}

		if (filesToProcess.size === 0) {
			new Notice('Картинок в заметке не найдено.');
			return;
		}

		// --- Окно прогресса для вычисления хэшей ---
		let hashProgressModal: ProgressModal | null = null;
		if (this.settings.enableHash) {
			hashProgressModal = new ProgressModal(this.app, filesToProcess.size, 'Вычисление хэшей...');
			hashProgressModal.open();
		}

		let processedHashes = 0; // Счетчик обработанных файлов
		const filesArray = Array.from(filesToProcess);
		
		const fileDataPromises = filesArray.map(async (file) => {
			let shortHash = '';
			
			if (this.settings.enableHash) {
				try {
					const buffer = await this.app.vault.readBinary(file);
					const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
					const hashArray = Array.from(new Uint8Array(hashBuffer));
					const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
					shortHash = hashHex.substring(0, 8);
				} catch (e) {
					console.error("Не удалось вычислить хэш для файла:", file.path, e);
				}
			}

			// Обновляем окно прогресса (если оно открыто)
			if (hashProgressModal) {
				processedHashes++;
				hashProgressModal.updateProgress(processedHashes, file.name);
			}

			return {
				file,
				linkedNotes: this.getLinkedNotes(file),
				hash: shortHash
			};
		});

		const fileData: FileToProcessData[] = await Promise.all(fileDataPromises);

		// Прячем окно прогресса
		if (hashProgressModal) {
			hashProgressModal.close();
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
		const updateLinksEnabled = (this.app.vault as any).getConfig('alwaysUpdateLinks') as boolean;

		if (updateLinksEnabled !== true) {
			const warningMsg = 'В настройках Obsidian (Файлы и ссылки) ОТКЛЮЧЕНА галочка "Всегда обновлять внутренние ссылки".\n\nЕсли вы продолжите, файлы будут переименованы, но ссылки в заметках НЕ ОБНОВЯТСЯ и картинки перестанут отображаться.\n\nВы точно хотите продолжить?';
			
			new ConfirmModal(this.app, warningMsg, () => {
				new RenamePreviewModal(this.app, this, fileData, activeFile, view).open();
			}).open();
		} else {
			new RenamePreviewModal(this.app, this, fileData, activeFile, view).open();
		}
	}

	getLinkedNotes(file: TFile): string[] {
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const linkedNotes: string[] = [];
		
		for (const sourcePath in resolvedLinks) {
			if (resolvedLinks[sourcePath][file.path] !== undefined) {
				const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
				if (sourceFile instanceof TFile) {
					linkedNotes.push(sourceFile.path);
				}
			}
		}
		return linkedNotes;
	}
}

// --- УНИВЕРСАЛЬНЫЙ КЛАСС ДЛЯ ПРОГРЕСС-БАРА ---
class ProgressModal extends Modal {
	total: number;
	current: number = 0;
	title: string;
	progressBarEl!: HTMLElement;
	progressTextEl!: HTMLElement;

	constructor(app: App, total: number, title: string) {
		super(app);
		this.total = total;
		this.title = title;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('ls-progress-modal');
		
		contentEl.createEl('h3', { text: this.title });
		
		const barContainer = contentEl.createDiv({ cls: 'ls-progress-bar-container' });
		this.progressBarEl = barContainer.createDiv({ cls: 'ls-progress-bar-fill' });
		
		this.progressTextEl = contentEl.createDiv({ cls: 'ls-progress-text', text: `Подготовка...` });
	}

	updateProgress(current: number, fileName: string) {
		this.current = current;
		const percentage = Math.round((this.current / this.total) * 100);
		this.progressBarEl.style.width = `${percentage}%`;
		this.progressTextEl.innerText = `Обработано: ${this.current} / ${this.total}\n(${fileName})`;
	}

	onClose() {
		this.contentEl.empty();
	}
}

class RenamePreviewModal extends Modal {
	plugin: LSRenamerPlugin;
	itemStates: FileState[]; 
	activeFile: TFile;
	activeView: MarkdownView;
	
	localSettings: LSRenamerSettings;
	tasks: RenameTask[] = [];
	checkboxes: { task: RenameTask, checkbox: HTMLInputElement }[] = [];
	
	listContainerEl!: HTMLElement;

	constructor(app: App, plugin: LSRenamerPlugin, fileData: FileToProcessData[], activeFile: TFile, activeView: MarkdownView) {
		super(app);
		this.plugin = plugin;
		this.activeFile = activeFile;
		this.activeView = activeView;
		
		this.itemStates = fileData.map(data => ({ data, userUnchecked: false }));
		this.localSettings = Object.assign({}, this.plugin.settings);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('ls-renamer-modal');

		contentEl.createEl('h2', { text: 'Предпросмотр переименования', cls: 'ls-renamer-modal-heading' });

		const settingsBar = contentEl.createDiv({ cls: 'ls-renamer-modal-settings' });

		const templateItem = settingsBar.createDiv({ cls: 'ls-renamer-setting-item' });
		const labelText = this.plugin.settings.enableHash 
			? 'Шаблон: {{originalname}}, {{notename}}, {{index}}, {{date}}, {{hash}}'
			: 'Шаблон: {{originalname}}, {{notename}}, {{index}}, {{date}}';
		
		templateItem.createEl('label', { text: labelText });
		
		const templateInput = templateItem.createEl('input', { type: 'text', cls: 'ls-renamer-template-input' });
		templateInput.value = this.localSettings.template;
		templateInput.oninput = (e) => {
			this.localSettings.template = (e.target as HTMLInputElement).value || '{{notename}}-{{index}}';
			this.updateTasksAndRender();
		};

		const dateItem = settingsBar.createDiv({ cls: 'ls-renamer-setting-item' });
		dateItem.createEl('label', { text: 'Формат даты' });
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		const dateInput = dateItem.createEl('input', { type: 'text', cls: 'ls-renamer-date-input', attr: { placeholder: 'YYYYMMDDHHmmss' } });
		dateInput.value = this.localSettings.dateFormat;
		dateInput.oninput = (e) => {
			this.localSettings.dateFormat = (e.target as HTMLInputElement).value || 'YYYYMMDDHHmmss';
			this.updateTasksAndRender();
		};

		const indexItem = settingsBar.createDiv({ cls: 'ls-renamer-setting-item' });
		indexItem.createEl('label', { text: 'Формат нумерации' });
		const indexSelect = indexItem.createEl('select');
		indexSelect.add(new Option('1, 2, 3...', '1'));
		indexSelect.add(new Option('01, 02, 03...', '2'));
		indexSelect.add(new Option('001, 002...', '3'));
		indexSelect.add(new Option('0001, 0002...', '4'));
		indexSelect.value = this.localSettings.indexDigits.toString();
		indexSelect.onchange = (e) => {
			this.localSettings.indexDigits = parseInt((e.target as HTMLSelectElement).value);
			this.updateTasksAndRender();
		};

		const actionItem = settingsBar.createDiv({ cls: 'ls-renamer-setting-item' });
		actionItem.createEl('label', { text: 'Действие для общих картинок' });
		const actionSelect = actionItem.createEl('select');
		actionSelect.add(new Option('Пропустить (не переименовывать)', 'skip'));
		actionSelect.add(new Option('Переименовать (для всех заметок)', 'rename_all'));
		actionSelect.add(new Option('Копировать (для текущей заметки)', 'copy'));
		actionSelect.value = this.localSettings.multiNoteAction;
		actionSelect.onchange = (e) => {
			this.localSettings.multiNoteAction = (e.target as HTMLSelectElement).value as 'skip' | 'rename_all' | 'copy';
			this.updateTasksAndRender();
		};

		const toggleItem = settingsBar.createDiv({ cls: 'ls-renamer-setting-item ls-renamer-setting-toggle' });
		const continuousToggle = toggleItem.createEl('input', { type: 'checkbox', attr: { id: 'ls-continuous-toggle' } });
		continuousToggle.checked = this.localSettings.continuousNumbering;
		const toggleLabel = toggleItem.createEl('label', { text: 'Сплошная нумерация (игнорировать пропущенные)' });
		toggleLabel.setAttribute('for', 'ls-continuous-toggle');
		
		continuousToggle.onchange = (e) => {
			this.localSettings.continuousNumbering = (e.target as HTMLInputElement).checked;
			this.updateTasksAndRender();
		};

		this.listContainerEl = contentEl.createDiv({ cls: 'ls-renamer-list' });

		const buttonsEl = contentEl.createDiv({ cls: 'ls-renamer-buttons' });
		const cancelBtn = buttonsEl.createEl('button', { text: 'Отмена' });
		cancelBtn.onclick = () => this.close();

		const applyBtn = buttonsEl.createEl('button', { text: 'Применить', cls: 'mod-cta' });
		applyBtn.onclick = () => {
			void this.executeRenames();
			this.close(); 
		};

		this.updateTasksAndRender();
	}

	getProposedPath(baseNoteName: string, ext: string, index: number, parentPath: string, file: TFile, hash: string) {
		const indexStr = index.toString().padStart(this.localSettings.indexDigits, '0');
		// Используем window.moment
		const dateStr = window.moment(file.stat.ctime).format(this.localSettings.dateFormat);
		
		const newBaseName = this.localSettings.template
			.replace(/{{notename}}/gi, baseNoteName)
			.replace(/{{index}}/gi, indexStr)
			.replace(/{{originalname}}/gi, file.basename)
			.replace(/{{date}}/gi, dateStr)
			.replace(/{{hash}}/gi, hash);
		
		const proposedName = `${newBaseName}.${ext}`;
		const prefix = (parentPath === '' || parentPath === '/') ? '' : parentPath + '/';
		const proposedPath = `${prefix}${proposedName}`;

		return { proposedName, proposedPath, proposedBaseName: newBaseName };
	}

	updateTasksAndRender() {
		const scrollTop = this.listContainerEl ? this.listContainerEl.scrollTop : 0;

		this.tasks = [];
		this.checkboxes = [];
		let index = 1;

		// Собираем все уже назначенные базовые имена (без расширения), чтобы избежать конфликтов
		const assignedBaseNames = new Set<string>();

		for (const state of this.itemStates) {
			const file = state.data.file;
			const hash = state.data.hash;
			const task = new RenameTask(file);
			task.linkedNotes = state.data.linkedNotes;

			const baseNoteName = this.activeFile.basename;
			const ext = file.extension;
			const parentPath = file.parent ? file.parent.path : '';
			
			const isShared = task.linkedNotes.length > 1;
			const isSettingSkip = isShared && this.localSettings.multiNoteAction === 'skip';
			const isSkipped = state.userUnchecked || isSettingSkip;

			let targetAction: 'rename' | 'copy' = 'rename';
			if (isShared && this.localSettings.multiNoteAction === 'copy') {
				targetAction = 'copy';
			}

			if (isSkipped) {
				task.action = 'skip';
				// Всегда вычисляем базовое имя и добавляем в занятые, чтобы следующие файлы не получили такой же индекс
				const { proposedName, proposedPath, proposedBaseName } = this.getProposedPath(baseNoteName, ext, index, parentPath, file, hash);
				task.proposedName = proposedName; 
				task.proposedPath = proposedPath;
				assignedBaseNames.add(proposedBaseName);
				index++;
			} else {
				let isUnique = false;
				
				while (!isUnique) {
					const { proposedName, proposedPath, proposedBaseName } = this.getProposedPath(baseNoteName, ext, index, parentPath, file, hash);
					const existingFile = this.app.vault.getAbstractFileByPath(proposedPath);
					
					// Проверяем: нет на диске И базовое имя не занято
					if (!existingFile && !assignedBaseNames.has(proposedBaseName)) {
						isUnique = true;
						task.action = targetAction;
						task.proposedName = proposedName;
						task.proposedPath = proposedPath;
						assignedBaseNames.add(proposedBaseName);
					} else if (existingFile && existingFile.path === file.path) {
						if (targetAction === 'copy') {
							index++;
						} else {
							isUnique = true;
							task.action = 'already_done';
							task.proposedName = proposedName;
							task.proposedPath = proposedPath;
							assignedBaseNames.add(proposedBaseName);
						}
					} else {
						index++;
					}
				}
				index++; 
			}

			this.tasks.push(task);
		}

		this.listContainerEl.empty();

		this.tasks.forEach((task, i) => {
			const state = this.itemStates[i];
			const isSettingSkip = task.linkedNotes.length > 1 && this.localSettings.multiNoteAction === 'skip';

			const itemEl = this.listContainerEl.createDiv({ cls: 'ls-renamer-item ls-renamer-item-col' });
			
			if (task.action === 'skip' || task.action === 'already_done') {
				itemEl.addClass('is-disabled');
				if (isSettingSkip || task.action === 'already_done') {
					itemEl.addClass('is-locked');
				}
			}

			const namesRow = itemEl.createDiv({ cls: 'ls-renamer-names-row' });
			
			const checkbox = namesRow.createEl('input', { type: 'checkbox' });
			
			if (task.action === 'already_done' || isSettingSkip) {
				checkbox.checked = false; 
				checkbox.disabled = true;
			} else {
				checkbox.checked = !state.userUnchecked;
			}

			this.checkboxes.push({ task, checkbox });

			let badgeText = '';
			let badgeClass = 'ls-renamer-badge ls-status-badge'; 
			
			if (task.action === 'already_done') {
				badgeText = 'Без изменений';
				badgeClass += ' is-success'; 
			} else if (task.action === 'skip') {
				badgeText = 'Пропустить';
				badgeClass += ' is-warning'; 
			} else if (task.action === 'rename') {
				badgeText = 'Переименовать';
			} else if (task.action === 'copy') {
				badgeText = 'Копировать';
			}
			
			namesRow.createSpan({ text: badgeText, cls: badgeClass });

			if (!checkbox.disabled) {
				checkbox.addEventListener('change', (e) => {
					state.userUnchecked = !(e.target as HTMLInputElement).checked;
					this.updateTasksAndRender(); 
				});
			}

			const namesEl = namesRow.createDiv({ cls: 'ls-renamer-names' });
			
			if (task.action === 'skip') {
				namesEl.createSpan({ text: task.oldName, cls: 'ls-renamer-old-name-normal' });
				if (task.proposedName && !this.localSettings.continuousNumbering) {
					namesEl.createSpan({ text: '➔', cls: 'ls-renamer-arrow' });
					namesEl.createSpan({ text: task.proposedName, cls: 'ls-renamer-new-name-crossed' });
				}
			} else if (task.action === 'already_done') {
				namesEl.createSpan({ text: task.oldName, cls: 'ls-renamer-old-name-normal' });
			} else {
				namesEl.createSpan({ text: task.oldName, cls: 'ls-renamer-old-name' });
				namesEl.createSpan({ text: '➔', cls: 'ls-renamer-arrow' });
				namesEl.createSpan({ text: task.proposedName, cls: 'ls-renamer-new-name' });
			}

			if (task.linkedNotes.length > 1) {
				const usageBox = itemEl.createDiv({ cls: 'ls-renamer-usage-box ls-indent' });
				usageBox.createSpan({ text: `Используется в ${task.linkedNotes.length} заметках:`, cls: 'ls-renamer-badge' });

				const notesContainer = usageBox.createDiv({ cls: 'ls-renamer-notes-list' });
				const currentNotePath = this.activeFile.path;
				notesContainer.createDiv({ text: `• ${currentNotePath} (данная заметка)` });

				const otherNotes = task.linkedNotes.filter(notePath => notePath !== currentNotePath);
				otherNotes.forEach(notePath => {
					notesContainer.createDiv({ text: `• ${notePath}` });
				});
			}
		});

		this.listContainerEl.scrollTop = scrollTop;
	}

	async executeRenames() {
		const itemsToProcess = this.checkboxes.filter(item => item.checkbox.checked);
		if (itemsToProcess.length === 0) return;

		const progressModal = new ProgressModal(this.app, itemsToProcess.length, 'Применение изменений...');
		progressModal.open();

		let processed = 0;
		const editor = this.activeView.editor;
		
		let currentText = editor.getValue();
		let isTextChanged = false;

		for (let i = 0; i < itemsToProcess.length; i++) {
			const task = itemsToProcess[i].task;
			
			progressModal.updateProgress(i + 1, task.oldName);

			try {
				if (task.action === 'rename') {
					await this.app.fileManager.renameFile(task.file, task.proposedPath);
					processed++;
				} 
				else if (task.action === 'copy') {
					await this.app.vault.copy(task.file, task.proposedPath);
					
					const escapedOldName = task.oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					const regex = new RegExp(`(!\\[\\[|!\\[.*?\\]\\()([^|\\]\\)]*?${escapedOldName})([|\\]\\)])`, 'gi');
					
					const newText = currentText.replace(regex, `$1${task.proposedName}$3`);
					if (newText !== currentText) {
						currentText = newText;
						isTextChanged = true; 
					}
					processed++;
				}
			} catch (err) {
				console.error("Ошибка при обработке файла", task.file.path, err);
			}
		}

		if (isTextChanged) {
			editor.setValue(currentText);
		}

		progressModal.close();
		new Notice(`Готово! Обработано файлов: ${processed}`);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ConfirmModal extends Modal {
	message: string;
	onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		
		contentEl.createEl('h2', { text: '⚠️ Внимание!' });
		
		contentEl.createEl('p', { text: this.message, cls: 'ls-renamer-warning-text' });

		const buttonsEl = contentEl.createDiv({ cls: 'ls-renamer-buttons' });
		
		const btnNo = buttonsEl.createEl('button', { text: 'Отмена' });
		btnNo.onclick = () => this.close();

		const btnYes = buttonsEl.createEl('button', { text: 'Да, сломать ссылки', cls: 'mod-warning' });
		btnYes.onclick = () => {
			this.close();
			this.onConfirm();
		};
	}
	
	onClose() {
		this.contentEl.empty();
	}
}

class LSRenamerSettingTab extends PluginSettingTab {
	plugin: LSRenamerPlugin;

	constructor(app: App, plugin: LSRenamerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Настройки simple image renamer').setHeading();

		const templateDesc = this.plugin.settings.enableHash
			? 'Доступные переменные: {{notename}}, {{index}}, {{originalname}}, {{date}}, {{hash}}'
			: 'Доступные переменные: {{notename}}, {{index}}, {{originalname}}, {{date}}';

		new Setting(containerEl)
			.setName('Шаблон имени файла')
			.setDesc(templateDesc)
			.addText(text => {
				text.inputEl.addClass('ls-renamer-settings-input');
				
				text.setPlaceholder('{{notename}}-{{index}}')
					.setValue(this.plugin.settings.template)
					.onChange(async (value) => {
						this.plugin.settings.template = value || '{{notename}}-{{index}}';
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Формат даты')
			.setDesc('Используется для переменной {{date}} (по умолчанию YYYYMMDDHHmmss).')
			.addText(text => {
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				text.setPlaceholder('YYYYMMDDHHmmss')
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (value) => {
						this.plugin.settings.dateFormat = value || 'YYYYMMDDHHmmss';
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Формат нумерации (индекс)')
			.setDesc('Сколько цифр использовать для переменной {{index}}.')
			.addDropdown(drop => drop
				.addOptions({ '1': '1, 2, 3...', '2': '01, 02, 03...', '3': '001, 002...', '4': '0001, 0002...' })
				.setValue(this.plugin.settings.indexDigits.toString())
				.onChange(async (value) => {
					this.plugin.settings.indexDigits = parseInt(value);
					await this.plugin.saveSettings();
				}));
				
		new Setting(containerEl)
			.setName('Сплошная нумерация')
			.setDesc('Если включено, файлы со статусом "Пропустить" не будут занимать индексы в счетчике.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.continuousNumbering)
				.onChange(async (value) => {
					this.plugin.settings.continuousNumbering = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Разрешить переменную {{hash}}')
			.setDesc('Вычисляет уникальный хэш файла. ВНИМАНИЕ: Если в заметке много тяжелых картинок, чтение файлов может замедлить появление окна предпросмотра.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableHash)
				.onChange(async (value) => {
					this.plugin.settings.enableHash = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl).setName('Картинки из нескольких заметок').setHeading();
		containerEl.createEl('p', { 
			text: 'Что делать, если картинка вставлена в текущую заметку, но также используется в других заметках?', 
			cls: 'ls-renamer-setting-desc' 
		});

		new Setting(containerEl)
			.setName('Действие')
			.addDropdown(drop => drop
				.addOptions({
					'skip': 'Пропустить (не переименовывать)',
					'rename_all': 'Переименовать (для всех заметок)',
					'copy': 'Копировать (для текущей заметки)'
				})
				.setValue(this.plugin.settings.multiNoteAction)
				.onChange(async (value: string) => {
					this.plugin.settings.multiNoteAction = value as 'skip' | 'rename_all' | 'copy';
					await this.plugin.saveSettings();
				}));
	}
}