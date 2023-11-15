import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified';
import { remark } from 'remark';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

		this.addCommand({
			id: "generate-anki-cards",
			name: "Generate Anki Cards",
			callback: async () => {
				// get contents of a markdown file
				const file = this.app.workspace.activeEditor?.file
				if (!file) {
					return
				}

				const contents = await this.app.vault.read(file)
				const tags = []
				let deck = "Default"

				const processor = unified().use(remarkParse).parse(contents)

				const u = unified()
					.use(remarkParse)
					.use(remarkGfm)
					.use(remarkRehype)
					.use(rehypeStringify, { allowDangerousHtml: true })
					.use({ settings: { bullet: "-" } })

				function getChildren(node: any): any {
					const children = []
					for (const child of node.children) {
						if (child.type === "text") {
							children.push(child.value)
						} else if (child.type === "inlineCode") {
							children.push("`" + child.value + "`")
						} else if (child.type === "paragraph") {
							children.push(getChildren(child))
						} else if (child.type === "list") {
							for (const listItem of child.children) {
								children.push(getChildren(listItem))
							}
						} else if (child.type === "code") {
							children.push("```" + child.lang + "\n" + child.value + "\n```")
						}
					}

					return children
				}

				const cards: { [key: string]: any } = {}
				let currentCard = null
				let additonalFront = false
				// let additonalBack = false
				for (let i = 0; i < processor.children.length; i++) {
					const element = processor.children[i];
					if (element.type === "html") {
						if (element.value.startsWith("<!--") && element.value.endsWith("-->")) {
							if (element.value.includes("AnkiFront:start")) {
								additonalFront = true
								continue
							} else if (element.value.includes("AnkiFront:end")) {
								additonalFront = false
								continue
							}

							// anki id and hash are always after heading containing #card tag
							if (currentCard && currentCard?.position?.start.line === element.position!.start.line - 1) {
								const [_, ankiId, md5hash, __] = element.value.split(" ")
								const key = (currentCard.children[0] as any)?.value
								cards[key].ankiId = ankiId
								cards[key].hash = md5hash
							}
						}

						continue
					}

					if (element.type === "heading") {
						// file info
						const key = (element.children[0] as any)?.value
						if (i === 1) {
							const [rawTags, rawDeck] = key.split("\n")
							const _tags = rawTags.split(" ").slice(1)
							const _deck = rawDeck.split("deck:")[1]

							deck = "all::" + _deck.trim()
							tags.push(..._tags)
						} else {
							currentCard = element
							const depth = element.depth
							const position = element.position

							if (key.includes("#card")) {
								cards[key] = { front: [element], back: [], depth, position, ankiId: null, hash: null }
							} else {
								currentCard = null
							}
						}
					} else if (currentCard) {
						if (additonalFront) {
							cards[(currentCard.children[0] as any)?.value].front.push(element)
						} else {
							cards[(currentCard.children[0] as any)?.value].back.push(element)
						}
					}
				}

				const crypto = require('crypto');

				let pattern = /#card\s*(.*)/g
				let count = 0 // how many anki ids we have inserted
				for await (const [key, value] of Object.entries(cards)) {
					const front = value.front
					const back = value.back
					const backTexts = []
					const frontTexts = []
					const images = []

					for (const element of back) {
						if (element.type === "paragraph") {
							for (const child of element.children) {
								if (child.type === "text") {
									backTexts.push(child.value)
								} else if (child.type === "inlineCode") {
									backTexts.push("`" + child.value + "`")
								} else if (child.type === "image") {
									const imageText = `![${child.alt}](${child.url})`
									images.push(child.url)
									backTexts.push(imageText)
								}
							}
						} else if (element.type === "code") {
							backTexts.push("```" + element.lang + "\n" + element.value + "\n```")
						}

						backTexts.push("\n")
					}

					const heading = front[0].children[0].value.replace(pattern, "").trim()
					frontTexts.push(heading)
					frontTexts.push("\n")

					for (let i = 1; i < front.length; i++) {
						let element = front[i]
						if (element.type === "paragraph") {
							for (const child of element.children) {
								if (child.type === "text") {
									frontTexts.push(child.value)
								} else if (child.type === "inlineCode") {
									frontTexts.push("`" + child.value + "`")
								}
							}
						} else if (element.type === "list") {
							for (const listItem of element.children) {
								const children = getChildren(listItem)
								frontTexts.push("- " + children.join(" "))
							}
						} else if (element.type === "code") {
							frontTexts.push("```" + element.lang + "\n" + element.value + "\n```")
						}

						frontTexts.push("\n")
					}
					const backText = backTexts.join("\n")
					const frontText = frontTexts.join("\n")
					const joinedText = frontText + backText
					const md5hash = crypto.createHash('md5').update(joinedText).digest("hex")

					if (value.hash === md5hash) {
						continue
					}

					cards[key].hash = md5hash

					try {
						let action = "addNote"

						if (value.ankiId) {
							action = "updateNote"
						}

						const backHtml = await u()
							.process(backText)
						const frontHtml = await u()
							.process(frontText)

						// const mediaFilesAction = images.map((image: string) => {
						// 	return {
						// 		"action": "storeMediaFile",
						// 		"version": 6,
						// 		"params": {
						// 			"filename": image,
						// 		}
						// 	}
						// })


						const response = await fetch("http://localhost:8765", {
							method: "POST",
							body: JSON.stringify(
								{
									"action": "multi",
									"version": 6,
									"params": {
										"actions": [
											{
												"action": action,
												"version": 6,
												"params": {
													"note": {
														"id": Number(value.ankiId) ? Number(value.ankiId) : null,
														"deckName": deck,
														"modelName": "Basic-23794",
														"fields": {
															"Front": String(frontHtml),
															"Back": String(backHtml)
														},
														"tags": tags,
													}
												}
											},
											// ...mediaFilesAction,
										]
									}
								}
							)
						})

						const data = await response.json()
						if (data.error) {
							console.log(data.error)
						} else if (!data.result[0].error) {
							if (action === "addNote") {
								const ankiId = data.result[0].result
								cards[key].ankiId = ankiId

								const line = value.position.start.line - 1
								const hashtag = "#".repeat(value.depth)
								this.app.workspace.activeEditor?.editor?.setLine(line + count, `${hashtag} ${key}\n<!-- ${ankiId} ${md5hash} -->`)
								count++
							} else { // updateNote
								const ankiId = cards[key].ankiId
								const line = value.position.start.line
								this.app.workspace.activeEditor?.editor?.setLine(line + count, `<!-- ${ankiId} ${md5hash} -->`)
							}
						}
					} catch (e) {
						console.log(e)
					}
				}
			}
		})
	}

	onunload() {

		console.log("UNLOADING PLUGIN")
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
