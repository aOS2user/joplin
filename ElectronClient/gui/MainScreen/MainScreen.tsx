import * as React from 'react';
import ResizableLayout, { findItemByKey, LayoutItem, LayoutItemDirection } from '../ResizableLayout/ResizableLayout';
import NoteList from '../NoteList/NoteList';
import NoteEditor from '../NoteEditor/NoteEditor';
import NoteContentPropertiesDialog from '../NoteContentPropertiesDialog';
import ShareNoteDialog from '../ShareNoteDialog';
import NoteListControls from '../NoteListControls/NoteListControls';
import CommandService from 'lib/services/CommandService';
import PluginService from 'lib/services/plugin_service/PluginService';
import SideBar from '../SideBar/SideBar';
import UserWebview from '../plugin_service/UserWebview';

const produce = require('immer').default;
const { connect } = require('react-redux');
const { stateUtils } = require('lib/reducer.js');
const { PromptDialog } = require('../PromptDialog.min.js');
const NotePropertiesDialog = require('../NotePropertiesDialog.min.js');
const InteropServiceHelper = require('../../InteropServiceHelper.js');
const Setting = require('lib/models/Setting.js');
const { shim } = require('lib/shim');
const { themeStyle } = require('lib/theme.js');
const { _ } = require('lib/locale.js');
const { bridge } = require('electron').remote.require('./bridge');
const PluginManager = require('lib/services/PluginManager');
const EncryptionService = require('lib/services/EncryptionService');
const ipcRenderer = require('electron').ipcRenderer;
const { time } = require('lib/time-utils.js');

const PLUGIN_SIDEBAR_WIDTH = 200;

const commands = [
	require('./commands/editAlarm'),
	require('./commands/exportPdf'),
	require('./commands/hideModalMessage'),
	require('./commands/moveToFolder'),
	require('./commands/newNote'),
	require('./commands/newFolder'),
	require('./commands/newTodo'),
	require('./commands/print'),
	require('./commands/renameFolder'),
	require('./commands/renameTag'),
	require('./commands/search'),
	require('./commands/selectTemplate'),
	require('./commands/setTags'),
	require('./commands/showModalMessage'),
	require('./commands/showNoteContentProperties'),
	require('./commands/showNoteProperties'),
	require('./commands/showShareNoteDialog'),
	require('./commands/toggleEditors'),
	require('./commands/toggleNoteList'),
	require('./commands/toggleSidebar'),
	require('./commands/toggleVisiblePanes'),
];

class MainScreenComponent extends React.Component<any, any> {

	waitForNotesSavedIID_:any;
	isPrinting_:boolean;
	styleKey_:string;
	styles_:any;
	promptOnClose_:Function;

	constructor(props:any) {
		super(props);

		this.state = {
			promptOptions: null,
			modalLayer: {
				visible: false,
				message: '',
			},
			notePropertiesDialogOptions: {},
			noteContentPropertiesDialogOptions: {},
			shareNoteDialogOptions: {},
			layout: this.buildLayout([]),
		};

		this.registerCommands();

		this.setupAppCloseHandling();

		this.commandService_commandsEnabledStateChange = this.commandService_commandsEnabledStateChange.bind(this);
		this.notePropertiesDialog_close = this.notePropertiesDialog_close.bind(this);
		this.noteContentPropertiesDialog_close = this.noteContentPropertiesDialog_close.bind(this);
		this.shareNoteDialog_close = this.shareNoteDialog_close.bind(this);
		this.userWebview_message = this.userWebview_message.bind(this);
		this.resizableLayout_resize = this.resizableLayout_resize.bind(this);
		this.resizableLayout_renderItem = this.resizableLayout_renderItem.bind(this);
		this.window_resize = this.window_resize.bind(this);
		this.rowHeight = this.rowHeight.bind(this);

		window.addEventListener('resize', this.window_resize);
	}

	buildLayout(plugins:any):LayoutItem {
		const rootLayoutSize = this.rootLayoutSize();
		const theme = themeStyle(this.props.themeId);
		const sideBarMinWidth = 200;

		const pluginColumnChildren = [];

		for (const pluginId in plugins) {
			const plugin = plugins[pluginId];
			for (const viewId in plugin.views) {
				const control = plugin.views[viewId];
				const key = `pluginView_${viewId}`;

				pluginColumnChildren.push({
					key: key,
					context: {
						plugin: plugin,
						control: control,
					},
				});
			}
		}

		return {
			key: 'root',
			direction: LayoutItemDirection.Row,
			width: rootLayoutSize.width,
			height: rootLayoutSize.height,
			children: [
				{
					key: 'sidebarColumn',
					direction: LayoutItemDirection.Column,
					resizableRight: true,
					width: Setting.value('style.sidebar.width') < sideBarMinWidth ? sideBarMinWidth : Setting.value('style.sidebar.width'),
					visible: Setting.value('sidebarVisibility'),
					minWidth: sideBarMinWidth,
					children: [
						{
							key: 'sideBar',
						},
					],
				},
				{
					key: 'noteListColumn',
					direction: LayoutItemDirection.Column,
					resizableRight: true,
					width: Setting.value('style.noteList.width') < sideBarMinWidth ? sideBarMinWidth : Setting.value('style.noteList.width'),
					visible: Setting.value('noteListVisibility'),
					minWidth: sideBarMinWidth,
					children: [
						{
							height: theme.topRowHeight,
							key: 'noteListControls',
						},
						{
							key: 'noteList',
						},
					],
				},
				{
					key: 'pluginColumn',
					direction: LayoutItemDirection.Column,
					resizableRight: true,
					width: 200,// Setting.value('style.noteList.width') < sideBarMinWidth ? sideBarMinWidth : Setting.value('style.noteList.width'),
					visible: !!pluginColumnChildren.length,
					minWidth: sideBarMinWidth,
					children: pluginColumnChildren,
				},
				{
					key: 'editorColumn',
					direction: LayoutItemDirection.Column,
					children: [
						{
							key: 'editor',
						},
					],
				},
			],
		};
	}

	window_resize() {
		this.updateRootLayoutSize();
	}

	setupAppCloseHandling() {
		this.waitForNotesSavedIID_ = null;

		// This event is dispached from the main process when the app is about
		// to close. The renderer process must respond with the "appCloseReply"
		// and tell the main process whether the app can really be closed or not.
		// For example, it cannot be closed right away if a note is being saved.
		// If a note is being saved, we wait till it is saved and then call
		// "appCloseReply" again.
		ipcRenderer.on('appClose', () => {
			if (this.waitForNotesSavedIID_) clearInterval(this.waitForNotesSavedIID_);
			this.waitForNotesSavedIID_ = null;

			ipcRenderer.send('asynchronous-message', 'appCloseReply', {
				canClose: !this.props.hasNotesBeingSaved,
			});

			if (this.props.hasNotesBeingSaved) {
				this.waitForNotesSavedIID_ = setInterval(() => {
					if (!this.props.hasNotesBeingSaved) {
						clearInterval(this.waitForNotesSavedIID_);
						this.waitForNotesSavedIID_ = null;
						ipcRenderer.send('asynchronous-message', 'appCloseReply', {
							canClose: true,
						});
					}
				}, 50);
			}
		});
	}

	notePropertiesDialog_close() {
		this.setState({ notePropertiesDialogOptions: {} });
	}

	noteContentPropertiesDialog_close() {
		this.setState({ noteContentPropertiesDialogOptions: {} });
	}

	shareNoteDialog_close() {
		this.setState({ shareNoteDialogOptions: {} });
	}

	commandService_commandsEnabledStateChange(event:any) {
		const buttonCommandNames = [
			'toggleSidebar',
			'toggleNoteList',
			'newNote',
			'newTodo',
			'newFolder',
			'toggleVisiblePanes',
		];

		for (const n of buttonCommandNames) {
			if (event.commands[n]) {
				this.forceUpdate();
				return;
			}
		}
	}

	updateRootLayoutSize() {
		this.setState({ layout: produce(this.state.layout, (draft:any) => {
			const s = this.rootLayoutSize();
			draft.width = s.width;
			draft.height = s.height;
		}) });
	}

	componentDidUpdate(prevProps:any) {
		if (this.props.noteListVisibility !== prevProps.noteListVisibility || this.props.sidebarVisibility !== prevProps.sidebarVisibility) {
			this.setState({ layout: produce(this.state.layout, (draft:any) => {
				const noteListColumn = findItemByKey(draft, 'noteListColumn');
				noteListColumn.visible = this.props.noteListVisibility;

				const sidebarColumn = findItemByKey(draft, 'sidebarColumn');
				sidebarColumn.visible = this.props.sidebarVisibility;
			}) });
		}

		if (prevProps.style.width !== this.props.style.width || prevProps.style.height !== this.props.style.height) {
			this.updateRootLayoutSize();
		}

		if (prevProps.plugins !== this.props.plugins) {
			this.setState({ layout: this.buildLayout(this.props.plugins) });
		}
	}

	componentDidMount() {
		CommandService.instance().on('commandsEnabledStateChange', this.commandService_commandsEnabledStateChange);
		this.updateRootLayoutSize();
	}

	componentWillUnmount() {
		CommandService.instance().off('commandsEnabledStateChange', this.commandService_commandsEnabledStateChange);
		this.unregisterCommands();

		window.removeEventListener('resize', this.window_resize);
	}

	toggleSidebar() {
		this.props.dispatch({
			type: 'SIDEBAR_VISIBILITY_TOGGLE',
		});
	}

	toggleNoteList() {
		this.props.dispatch({
			type: 'NOTELIST_VISIBILITY_TOGGLE',
		});
	}

	async waitForNoteToSaved(noteId:string) {
		while (noteId && this.props.editorNoteStatuses[noteId] === 'saving') {
			console.info('Waiting for note to be saved...', this.props.editorNoteStatuses);
			await time.msleep(100);
		}
	}

	async printTo_(target:string, options:any) {
		// Concurrent print calls are disallowed to avoid incorrect settings being restored upon completion
		if (this.isPrinting_) {
			console.info(`Printing ${options.path} to ${target} disallowed, already printing.`);
			return;
		}

		this.isPrinting_ = true;

		// Need to wait for save because the interop service reloads the note from the database
		await this.waitForNoteToSaved(options.noteId);

		if (target === 'pdf') {
			try {
				const pdfData = await InteropServiceHelper.exportNoteToPdf(options.noteId, {
					printBackground: true,
					pageSize: Setting.value('export.pdfPageSize'),
					landscape: Setting.value('export.pdfPageOrientation') === 'landscape',
					customCss: this.props.customCss,
				});
				await shim.fsDriver().writeFile(options.path, pdfData, 'buffer');
			} catch (error) {
				console.error(error);
				bridge().showErrorMessageBox(error.message);
			}
		} else if (target === 'printer') {
			try {
				await InteropServiceHelper.printNote(options.noteId, {
					printBackground: true,
					customCss: this.props.customCss,
				});
			} catch (error) {
				console.error(error);
				bridge().showErrorMessageBox(error.message);
			}
		}
		this.isPrinting_ = false;
	}

	rootLayoutSize() {
		return {
			width: window.innerWidth,
			height: this.rowHeight(),
		};
	}

	rowHeight() {
		if (!this.props) return 0;
		return this.props.style.height - (this.messageBoxVisible() ? this.messageBoxHeight() : 0);
	}

	messageBoxHeight() {
		return 50;
	}

	styles(themeId:number, width:number, height:number, messageBoxVisible:boolean, isSidebarVisible:any, isNoteListVisible:any, sidebarWidth:number, noteListWidth:number, pluginSidebarCount:number) {
		const styleKey = [themeId, width, height, messageBoxVisible, +isSidebarVisible, +isNoteListVisible, sidebarWidth, noteListWidth, pluginSidebarCount].join('_');
		if (styleKey === this.styleKey_) return this.styles_;

		const theme = themeStyle(themeId);

		this.styleKey_ = styleKey;

		this.styles_ = {};

		this.styles_.header = {
			width: width,
		};

		this.styles_.messageBox = {
			width: width,
			height: this.messageBoxHeight(),
			display: 'flex',
			alignItems: 'center',
			paddingLeft: 10,
			backgroundColor: theme.warningBackgroundColor,
		};

		const rowHeight = height - (messageBoxVisible ? this.styles_.messageBox.height : 0);

		this.styles_.rowHeight = rowHeight;

		this.styles_.verticalResizerSidebar = {
			width: 5,
			// HACK: For unknown reasons, the resizers are just a little bit taller than the other elements,
			// making the whole window scroll vertically. So we remove 10 extra pixels here.
			height: rowHeight - 10,
			display: 'inline-block',
		};

		this.styles_.resizableLayout = {
			height: rowHeight,
		};

		this.styles_.verticalResizerNotelist = Object.assign({}, this.styles_.verticalResizerSidebar);

		this.styles_.sideBar = {
			width: sidebarWidth - this.styles_.verticalResizerSidebar.width,
			height: rowHeight,
			display: 'inline-block',
			verticalAlign: 'top',
		};

		if (isSidebarVisible === false) {
			this.styles_.sideBar.width = 0;
			this.styles_.sideBar.display = 'none';
			this.styles_.verticalResizerSidebar.display = 'none';
		}

		this.styles_.noteList = {
			width: noteListWidth - this.styles_.verticalResizerNotelist.width,
			height: rowHeight,
			display: 'inline-block',
			verticalAlign: 'top',
		};

		if (isNoteListVisible === false) {
			this.styles_.noteList.width = 0;
			this.styles_.noteList.display = 'none';
			this.styles_.verticalResizerNotelist.display = 'none';
		}

		this.styles_.noteText = {
			width: Math.floor(width - this.styles_.sideBar.width - this.styles_.noteList.width - 10) - PLUGIN_SIDEBAR_WIDTH * pluginSidebarCount,
			height: rowHeight,
			display: 'inline-block',
			verticalAlign: 'top',
		};

		this.styles_.prompt = {
			width: width,
			height: height,
		};

		this.styles_.modalLayer = Object.assign({}, theme.textStyle, {
			zIndex: 10000,
			position: 'absolute',
			top: 0,
			left: 0,
			backgroundColor: theme.backgroundColor,
			width: width - 20,
			height: height - 20,
			padding: 10,
		});

		return this.styles_;
	}

	renderNotification(theme:any, styles:any) {
		if (!this.messageBoxVisible()) return null;

		const onViewStatusScreen = () => {
			this.props.dispatch({
				type: 'NAV_GO',
				routeName: 'Status',
			});
		};

		const onViewEncryptionConfigScreen = () => {
			this.props.dispatch({
				type: 'NAV_GO',
				routeName: 'Config',
				props: {
					defaultSection: 'encryption',
				},
			});
		};

		const onRestartAndUpgrade = async () => {
			Setting.setValue('sync.upgradeState', Setting.SYNC_UPGRADE_STATE_MUST_DO);
			await Setting.saveAll();
			bridge().restart();
		};

		let msg = null;
		if (this.props.shouldUpgradeSyncTarget) {
			msg = (
				<span>
					{_('The sync target needs to be upgraded before Joplin can sync. The operation may take a few minutes to complete and the app needs to be restarted. To proceed please click on the link.')}{' '}
					<a href="#" onClick={() => onRestartAndUpgrade()}>
						{_('Restart and upgrade')}
					</a>
				</span>
			);
		} else if (this.props.hasDisabledSyncItems) {
			msg = (
				<span>
					{_('Some items cannot be synchronised.')}{' '}
					<a href="#" onClick={() => onViewStatusScreen()}>
						{_('View them now')}
					</a>
				</span>
			);
		} else if (this.props.hasDisabledEncryptionItems) {
			msg = (
				<span>
					{_('Some items cannot be decrypted.')}{' '}
					<a href="#" onClick={() => onViewStatusScreen()}>
						{_('View them now')}
					</a>
				</span>
			);
		} else if (this.props.showMissingMasterKeyMessage) {
			msg = (
				<span>
					{_('One or more master keys need a password.')}{' '}
					<a href="#" onClick={() => onViewEncryptionConfigScreen()}>
						{_('Set the password')}
					</a>
				</span>
			);
		} else if (this.props.showNeedUpgradingMasterKeyMessage) {
			msg = (
				<span>
					{_('One of your master keys use an obsolete encryption method.')}{' '}
					<a href="#" onClick={() => onViewEncryptionConfigScreen()}>
						{_('View them now')}
					</a>
				</span>
			);
		} else if (this.props.showShouldReencryptMessage) {
			msg = (
				<span>
					{_('The default encryption method has been changed, you should re-encrypt your data.')}{' '}
					<a href="#" onClick={() => onViewEncryptionConfigScreen()}>
						{_('More info')}
					</a>
				</span>
			);
		}

		return (
			<div style={styles.messageBox}>
				<span style={theme.textStyle}>{msg}</span>
			</div>
		);
	}

	messageBoxVisible() {
		return this.props.hasDisabledSyncItems || this.props.showMissingMasterKeyMessage || this.props.showNeedUpgradingMasterKeyMessage || this.props.showShouldReencryptMessage || this.props.hasDisabledEncryptionItems || this.props.shouldUpgradeSyncTarget;
	}

	registerCommands() {
		for (const command of commands) {
			CommandService.instance().registerRuntime(command.declaration.name, command.runtime(this));
		}
	}

	unregisterCommands() {
		for (const command of commands) {
			CommandService.instance().unregisterRuntime(command.declaration.name);
		}
	}

	pluginControlCount() {
		let output = 0;
		for (const pluginId in this.props.plugins) {
			const plugin = this.props.plugins[pluginId];
			if (!plugin.views) {
				console.error('Plugin without views key:', pluginId, this.props.plugins);
				continue;
			}
			output += Object.keys(plugin.views).length;
		}
		return output;
	}

	userWebview_message(event:any) {
		PluginService.instance().pluginById(event.pluginId).viewControllerById(event.viewId).emitMessage(event);
	}

	resizableLayout_resize(event:any) {
		this.setState({ layout: event.layout });

		const col1 = findItemByKey(event.layout, 'sidebarColumn');
		const col2 = findItemByKey(event.layout, 'noteListColumn');
		Setting.setValue('style.sidebar.width', col1.width);
		Setting.setValue('style.noteList.width', col2.width);
	}

	resizableLayout_renderItem(key:string, event:any) {
		const eventEmitter = event.eventEmitter;

		if (key === 'sideBar') {
			return <SideBar key={key} />;
		} else if (key === 'noteList') {
			return <NoteList key={key} resizableLayoutEventEmitter={eventEmitter} size={event.size} visible={event.visible}/>;
		} else if (key === 'editor') {
			const bodyEditor = this.props.settingEditorCodeView ? 'CodeMirror' : 'TinyMCE';
			return <NoteEditor key={key} bodyEditor={bodyEditor} />;
		} else if (key === 'noteListControls') {
			return <NoteListControls key={key} />;
		} else if (key.indexOf('pluginView_') === 0) {
			const { control, plugin } = event.item.context;
			return <UserWebview
				key={control.id}
				viewId={control.id}
				themeId={this.props.themeId}
				html={control.html}
				scripts={control.scripts}
				pluginId={plugin.id}
				onMessage={this.userWebview_message}
			/>;
		}

		throw new Error(`Invalid layout component: ${key}`);
	}

	render() {
		const theme = themeStyle(this.props.themeId);
		const style = Object.assign(
			{
				color: theme.color,
				backgroundColor: theme.backgroundColor,
			},
			this.props.style
		);
		const promptOptions = this.state.promptOptions;
		const sidebarVisibility = this.props.sidebarVisibility;
		const noteListVisibility = this.props.noteListVisibility;
		const styles = this.styles(this.props.themeId, style.width, style.height, this.messageBoxVisible(), sidebarVisibility, noteListVisibility, this.props.sidebarWidth, this.props.noteListWidth, this.pluginControlCount());

		if (!this.promptOnClose_) {
			this.promptOnClose_ = (answer:any, buttonType:any) => {
				return this.state.promptOptions.onClose(answer, buttonType);
			};
		}

		const messageComp = this.renderNotification(theme, styles);

		const dialogInfo = PluginManager.instance().pluginDialogToShow(this.props.pluginsLegacy);
		const pluginDialog = !dialogInfo ? null : <dialogInfo.Dialog {...dialogInfo.props} />;

		const modalLayerStyle = Object.assign({}, styles.modalLayer, { display: this.state.modalLayer.visible ? 'block' : 'none' });

		const notePropertiesDialogOptions = this.state.notePropertiesDialogOptions;
		const noteContentPropertiesDialogOptions = this.state.noteContentPropertiesDialogOptions;
		const shareNoteDialogOptions = this.state.shareNoteDialogOptions;

		return (
			<div style={style}>
				<div style={modalLayerStyle}>{this.state.modalLayer.message}</div>

				{noteContentPropertiesDialogOptions.visible && <NoteContentPropertiesDialog markupLanguage={noteContentPropertiesDialogOptions.markupLanguage} themeId={this.props.themeId} onClose={this.noteContentPropertiesDialog_close} text={noteContentPropertiesDialogOptions.text}/>}
				{notePropertiesDialogOptions.visible && <NotePropertiesDialog themeId={this.props.themeId} noteId={notePropertiesDialogOptions.noteId} onClose={this.notePropertiesDialog_close} onRevisionLinkClick={notePropertiesDialogOptions.onRevisionLinkClick} />}
				{shareNoteDialogOptions.visible && <ShareNoteDialog themeId={this.props.themeId} noteIds={shareNoteDialogOptions.noteIds} onClose={this.shareNoteDialog_close} />}

				<PromptDialog autocomplete={promptOptions && 'autocomplete' in promptOptions ? promptOptions.autocomplete : null} defaultValue={promptOptions && promptOptions.value ? promptOptions.value : ''} themeId={this.props.themeId} style={styles.prompt} onClose={this.promptOnClose_} label={promptOptions ? promptOptions.label : ''} description={promptOptions ? promptOptions.description : null} visible={!!this.state.promptOptions} buttons={promptOptions && 'buttons' in promptOptions ? promptOptions.buttons : null} inputType={promptOptions && 'inputType' in promptOptions ? promptOptions.inputType : null} />

				{messageComp}
				<ResizableLayout
					width={this.state.width}
					height={styles.rowHeight}
					layout={this.state.layout}
					onResize={this.resizableLayout_resize}
					renderItem={this.resizableLayout_renderItem}
				/>
				{pluginDialog}
			</div>
		);
	}
}

const mapStateToProps = (state:any) => {
	return {
		themeId: state.settings.theme,
		settingEditorCodeView: state.settings['editor.codeView'],
		sidebarVisibility: state.sidebarVisibility,
		noteListVisibility: state.noteListVisibility,
		folders: state.folders,
		notes: state.notes,
		hasDisabledSyncItems: state.hasDisabledSyncItems,
		hasDisabledEncryptionItems: state.hasDisabledEncryptionItems,
		showMissingMasterKeyMessage: state.notLoadedMasterKeys.length && state.masterKeys.length,
		showNeedUpgradingMasterKeyMessage: !!EncryptionService.instance().masterKeysThatNeedUpgrading(state.masterKeys).length,
		showShouldReencryptMessage: state.settings['encryption.shouldReencrypt'] >= Setting.SHOULD_REENCRYPT_YES,
		shouldUpgradeSyncTarget: state.settings['sync.upgradeState'] === Setting.SYNC_UPGRADE_STATE_SHOULD_DO,
		selectedFolderId: state.selectedFolderId,
		sidebarWidth: state.settings['style.sidebar.width'],
		noteListWidth: state.settings['style.noteList.width'],
		selectedNoteId: state.selectedNoteIds.length === 1 ? state.selectedNoteIds[0] : null,
		pluginsLegacy: state.pluginsLegacy,
		plugins: state.pluginService.plugins,
		templates: state.templates,
		customCss: state.customCss,
		editorNoteStatuses: state.editorNoteStatuses,
		hasNotesBeingSaved: stateUtils.hasNotesBeingSaved(state),
	};
};

export default connect(mapStateToProps)(MainScreenComponent);