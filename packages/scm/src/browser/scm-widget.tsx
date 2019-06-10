/********************************************************************************
 * Copyright (C) 2019 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

// tslint:disable:no-any
// tslint:disable:no-null-keyword

import * as React from 'react';
import { Message } from '@phosphor/messaging';
import { ElementExt } from '@phosphor/domutils';
import { injectable, inject, postConstruct } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { MenuModelRegistry, ActionMenuNode, CompositeMenuNode } from '@theia/core/lib/common/menu';
import { DisposableCollection, Disposable } from '@theia/core/lib/common/disposable';
import {
    ApplicationShell, ContextMenuRenderer, SELECTED_CLASS, StorageService,
    ReactWidget, Key, LabelProvider, DiffUris, KeybindingRegistry, Widget, StatefulWidget
} from '@theia/core/lib/browser';
import { AlertMessage } from '@theia/core/lib/browser/widgets/alert-message';
import { EditorManager, DiffNavigatorProvider, EditorWidget } from '@theia/editor/lib/browser';
import { ScmAvatarService } from './scm-avatar-service';
import { ScmAmendComponent } from './scm-amend-component';
import { ScmContextKeyService } from './scm-context-key-service';
import { ScmService } from './scm-service';
import { ScmInput } from './scm-input';
import { ScmRepository } from './scm-repository';
import { ScmResource, ScmResourceGroup } from './scm-provider';

@injectable()
export class ScmWidget extends ReactWidget implements StatefulWidget {

    static RESOURCE_GROUP_CONTEXT_MENU = ['RESOURCE_GROUP_CONTEXT_MENU'];
    static RESOURCE_GROUP_INLINE_MENU = ['RESOURCE_GROUP_INLINE_MENU'];

    static RESOURCE_INLINE_MENU = ['RESOURCE_INLINE_MENU'];
    static RESOURCE_CONTEXT_MENU = ['RESOURCE_CONTEXT_MENU'];

    protected static MESSAGE_BOX_MIN_HEIGHT = 25;
    protected static LABEL = 'Source Control';

    protected messageBoxHeight = ScmWidget.MESSAGE_BOX_MIN_HEIGHT;

    @inject(ScmService) protected readonly scmService: ScmService;
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;
    @inject(KeybindingRegistry) protected readonly keybindings: KeybindingRegistry;
    @inject(MenuModelRegistry) protected readonly menus: MenuModelRegistry;
    @inject(ScmContextKeyService) protected readonly contextKeys: ScmContextKeyService;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ContextMenuRenderer) protected readonly contextMenuRenderer: ContextMenuRenderer;
    @inject(ScmAvatarService) protected readonly avatarService: ScmAvatarService;
    @inject(StorageService) protected readonly storageService: StorageService;
    @inject(LabelProvider) protected readonly labelProvider: LabelProvider;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(DiffNavigatorProvider) protected readonly diffNavigatorProvider: DiffNavigatorProvider;

    // TODO: a hack to install DOM listeners, replace it with DOM, i.e. use TreeWidget instead
    protected _scrollContainer: string;
    protected set scrollContainer(id: string) {
        this._scrollContainer = id + Date.now();
    }
    protected get scrollContainer(): string {
        return this._scrollContainer;
    }

    constructor() {
        super();
        this.node.tabIndex = 0;
        this.id = 'theia-scmContainer';
        this.addClass('theia-scm');
        this.scrollContainer = ScmWidget.Styles.GROUPS_CONTAINER;

        this.title.iconClass = 'scm-tab-icon';
        this.title.label = ScmWidget.LABEL;
        this.title.caption = ScmWidget.LABEL;
        this.title.closable = true;
    }

    @postConstruct()
    protected init(): void {
        this.refresh();
        this.toDispose.push(this.scmService.onDidChangeSelectedRepository(() => this.refresh()));
    }

    protected readonly toDisposeOnRefresh = new DisposableCollection();
    protected refresh(): void {
        this.toDisposeOnRefresh.dispose();
        this.toDispose.push(this.toDisposeOnRefresh);
        const repository = this.scmService.selectedRepository;
        this.title.label = ScmWidget.LABEL;
        if (repository) {
            this.title.label += ': ' + repository.provider.label;
        }
        const area = this.shell.getAreaFor(this);
        if (area === 'left') {
            this.shell.leftPanelHandler.refresh();
        } else if (area === 'right') {
            this.shell.rightPanelHandler.refresh();
        }
        this.update();
        if (repository) {
            this.toDisposeOnRefresh.push(repository.onDidChange(() => this.update()));
            // render synchronously to avoid cursor jumping
            // see https://stackoverflow.com/questions/28922275/in-reactjs-why-does-setstate-behave-differently-when-called-synchronously/28922465#28922465
            this.toDisposeOnRefresh.push(repository.input.onDidChange(() => this.updateImmediately()));
            this.toDisposeOnRefresh.push(repository.input.onDidFocus(() => this.focusInput()));
        }
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        (this.input || this.node).focus();
    }

    protected onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.update();
    }

    protected updateImmediately(): void {
        this.onUpdateRequest(Widget.Msg.UpdateRequest);
    }

    protected onUpdateRequest(msg: Message): void {
        if (!this.isAttached || !this.isVisible) {
            return;
        }
        this.onRender.push(Disposable.create(() => async () => {
            const selected = this.node.getElementsByClassName(SELECTED_CLASS)[0];
            if (selected) {
                ElementExt.scrollIntoViewIfNeeded(this.node, selected);
            }
        }));
        super.onUpdateRequest(msg);
    }

    protected addScmListKeyListeners = (id: string) => {
        const container = document.getElementById(id);
        if (container) {
            this.addScmListNavigationKeyListeners(container);
        }
    }

    protected render(): React.ReactNode {
        const repository = this.scmService.selectedRepository;
        if (!repository) {
            return <AlertMessage
                type='WARNING'
                header='Source control is not available at this time'
            />;
        }
        const input = repository.input;
        const amendSupport = repository.provider.amendSupport;

        return <div className={ScmWidget.Styles.MAIN_CONTAINER}>
            <div className='headerContainer' style={{ flexGrow: 0 }}>
                {this.renderInput(input, repository)}
            </div>
            <ScmResourceGroupsContainer
                style={{ flexGrow: 1 }}
                id={this.scrollContainer}
                repository={repository}
                commands={this.commands}
                menus={this.menus}
                contextKeys={this.contextKeys}
                labelProvider={this.labelProvider}
                addScmListKeyListeners={this.addScmListKeyListeners}
                contextMenuRenderer={this.contextMenuRenderer}
            />
            {amendSupport && <ScmAmendComponent
                key={`amend:${repository.provider.rootUri}`}
                style={{ flexGrow: 0 }}
                id={this.scrollContainer}
                repository={repository}
                scmAmendSupport={amendSupport}
                setCommitMessage={this.setInputValue}
                avatarService={this.avatarService}
                storageService={this.storageService}
            />}
        </div>;
    }

    protected renderInput(input: ScmInput, repository: ScmRepository): React.ReactNode {
        this.onRender.push(Disposable.create(() => this.resizeInput()));

        const validationStatus = input.issue ? input.issue.type : 'idle';
        const validationMessage = input.issue ? input.issue.message : '';
        const format = (value: string, ...args: string[]): string => {
            if (args.length !== 0) {
                return value.replace(/{(\d+)}/g, (found, n) => {
                    const i = parseInt(n);
                    return isNaN(i) || i < 0 || i >= args.length ? found : args[i];
                });
            }
            return value;
        };

        const keybinding = this.keybindings.acceleratorFor(this.keybindings.getKeybindingsForCommand('scm.acceptInput')[0]).join('+');
        const message = format(input.placeholder || '', keybinding);
        return <div className={ScmWidget.Styles.INPUT_MESSAGE_CONTAINER}>
            <textarea
                className={`${ScmWidget.Styles.INPUT_MESSAGE} theia-scm-input-message-${validationStatus}`}
                style={{
                    height: this.messageBoxHeight,
                    overflow: this.messageBoxHeight > ScmWidget.MESSAGE_BOX_MIN_HEIGHT ? 'auto' : 'hidden'
                }}
                id={ScmWidget.Styles.INPUT_MESSAGE}
                placeholder={message}
                autoFocus={true}
                tabIndex={1}
                value={input.value}
                onChange={this.setInputValue}
                ref={this.setInput}>
            </textarea>
            <div
                className={
                    `${ScmWidget.Styles.VALIDATION_MESSAGE} ${ScmWidget.Styles.NO_SELECT}
                    theia-scm-validation-message-${validationStatus} theia-scm-input-message-${validationStatus}`
                }
                style={{
                    display: !!input.issue ? 'block' : 'none'
                }}>{validationMessage}</div>
        </div>;
    }

    /** don't modify DOM use React! only exposed for `focusInput` */
    protected input: HTMLTextAreaElement | null;
    protected setInput = (input: HTMLTextAreaElement | null) => {
        this.input = input;
    }
    protected focusInput(): void {
        if (this.input) {
            this.input.focus();
        }
    }
    /** TODO: a hack has to be implemented via React */
    protected resizeInput(): void {
        const input = this.input;
        if (!input) {
            return;
        }
        const fontSize = Number.parseInt(window.getComputedStyle(input, undefined).getPropertyValue('font-size').split('px')[0] || '0', 10);
        const { value } = input;
        if (Number.isInteger(fontSize) && fontSize > 0) {
            const requiredHeight = fontSize * value.split(/\r?\n/).length;
            if (requiredHeight < input.scrollHeight) {
                input.style.height = `${requiredHeight}px`;
            }
        }
        if (input.clientHeight < input.scrollHeight) {
            input.style.height = `${input.scrollHeight}px`;
            if (input.clientHeight < input.scrollHeight) {
                input.style.height = `${(input.scrollHeight * 2 - input.clientHeight)}px`;
            }
        }
        const updatedHeight = input.style.height;
        if (updatedHeight) {
            this.messageBoxHeight = parseInt(updatedHeight, 10) || ScmWidget.MESSAGE_BOX_MIN_HEIGHT;
            if (this.messageBoxHeight > ScmWidget.MESSAGE_BOX_MIN_HEIGHT) {
                input.style.overflow = 'auto';
            } else {
                // Hide the scroll-bar if we shrink down the size.
                input.style.overflow = 'hidden';
            }
        }
    }

    protected setInputValue = (event: React.ChangeEvent<HTMLTextAreaElement> | string) => {
        const repository = this.scmService.selectedRepository;
        if (repository) {
            repository.input.value = typeof event === 'string' ? event : event.currentTarget.value;
        }
    }

    protected acceptInput = () => this.commands.executeCommand('scm.acceptInput');

    protected addScmListNavigationKeyListeners(container: HTMLElement): void {
        this.addKeyListener(container, Key.ARROW_LEFT, () => this.openPreviousChange());
        this.addKeyListener(container, Key.ARROW_RIGHT, () => this.openNextChange());
        this.addKeyListener(container, Key.ARROW_UP, () => this.selectPreviousResource());
        this.addKeyListener(container, Key.ARROW_DOWN, () => this.selectNextResource());
        this.addKeyListener(container, Key.ENTER, () => this.openSelected());
    }

    protected async openPreviousChange(): Promise<void> {
        const repository = this.scmService.selectedRepository;
        if (!repository) {
            return;
        }
        const selected = repository.selectedResource;
        if (selected) {
            const widget = await this.openResource(selected);
            if (widget) {
                const diffNavigator = this.diffNavigatorProvider(widget.editor);
                if (diffNavigator.canNavigate() && diffNavigator.hasPrevious()) {
                    diffNavigator.previous();
                } else {
                    const previous = repository.selectPreviousResource();
                    if (previous) {
                        previous.open();
                    }
                }
            }
        }
    }

    protected async openNextChange(): Promise<void> {
        const repository = this.scmService.selectedRepository;
        if (!repository) {
            return;
        }
        const selected = repository.selectedResource;
        if (selected) {
            const widget = await this.openResource(selected);
            if (widget) {
                const diffNavigator = this.diffNavigatorProvider(widget.editor);
                if (diffNavigator.canNavigate() && diffNavigator.hasNext()) {
                    diffNavigator.next();
                } else {
                    const next = repository.selectNextResource();
                    if (next) {
                        next.open();
                    }
                }
            }
        } else if (repository && repository.resources.length) {
            repository.selectedResource = repository.resources[0];
            repository.selectedResource.open();
        }
    }

    protected async openResource(resource: ScmResource): Promise<EditorWidget | undefined> {
        await resource.open();

        let standaloneEditor: EditorWidget | undefined;
        const resourcePath = resource.sourceUri.path.toString();
        for (const widget of this.editorManager.all) {
            const resourceUri = widget.getResourceUri();
            const editorResourcePath = resourceUri && resourceUri.path.toString();
            if (resourcePath === editorResourcePath) {
                if (widget.editor.uri.scheme === DiffUris.DIFF_SCHEME) {
                    // prefer diff editor
                    return widget;
                } else {
                    standaloneEditor = widget;
                }
            }
            if (widget.editor.uri.scheme === DiffUris.DIFF_SCHEME
                && String(widget.getResourceUri()) === resource.sourceUri.toString()) {
                return widget;
            }
        }
        // fallback to standalone editor
        return standaloneEditor;
    }

    protected selectPreviousResource(): ScmResource | undefined {
        const repository = this.scmService.selectedRepository;
        return repository && repository.selectPreviousResource();
    }

    protected selectNextResource(): ScmResource | undefined {
        const repository = this.scmService.selectedRepository;
        return repository && repository.selectNextResource();
    }

    protected openSelected(): void {
        const repository = this.scmService.selectedRepository;
        const resource = repository && repository.selectedResource;
        if (resource) {
            resource.open();
        }
    }

    storeState(): any {
        const repository = this.scmService.selectedRepository;
        return repository && repository.input;
    }

    restoreState(oldState: any): void {
        const repository = this.scmService.selectedRepository;
        if (repository) {
            repository.input.fromJSON(oldState);
        }
    }

}

export namespace ScmWidget {

    export namespace Styles {
        export const MAIN_CONTAINER = 'theia-scm-main-container';
        export const PROVIDER_CONTAINER = 'theia-scm-provider-container';
        export const PROVIDER_NAME = 'theia-scm-provider-name';
        export const GROUPS_CONTAINER = 'groups-outer-container';
        export const INPUT_MESSAGE_CONTAINER = 'theia-scm-input-message-container';
        export const INPUT_MESSAGE = 'theia-scm-input-message';
        export const VALIDATION_MESSAGE = 'theia-scm-input-validation-message';
        export const NO_SELECT = 'no-select';
    }
    export interface Props {
        repository: ScmRepository;
        commands: CommandRegistry;
        menus: MenuModelRegistry;
        contextKeys: ScmContextKeyService;
        labelProvider: LabelProvider;
        contextMenuRenderer: ContextMenuRenderer
    }

}

export class ScmResourceComponent extends React.Component<ScmResourceComponent.Props> {
    render() {
        const { name, repository, resource, labelProvider, commands, menus, contextKeys } = this.props;
        const rootUri = resource.group.provider.rootUri;
        if (!rootUri) {
            return undefined;
        }
        const decorations = resource.decorations;
        const icon = decorations && decorations.icon || '';
        const color = decorations && decorations.color || '';
        const letter = decorations && decorations.letter || '';
        const tooltip = decorations && decorations.tooltip || '';
        const relativePath = new URI(rootUri).relative(resource.sourceUri.parent);
        const path = relativePath ? relativePath.toString() : labelProvider.getLongName(resource.sourceUri.parent);
        return <div key={String(resource.sourceUri)}
            className={`scmItem ${ScmWidget.Styles.NO_SELECT}${repository.selectedResource === resource ? ' ' + SELECTED_CLASS : ''}`}
            onContextMenu={this.renderContextMenu}>
            <div className='noWrapInfo' onDoubleClick={this.open} onClick={this.selectChange}>
                <span className={icon + ' file-icon'} />
                <span className='name'>{name}</span>
                <span className='path'>{path}</span>
            </div>
            <ScmInlineActions {...{
                menu: menus.getMenu(ScmWidget.RESOURCE_INLINE_MENU),
                args: [resource], // TODO support multi selection
                commands,
                contextKeys,
                group: resource.group
            }}>
                <div title={tooltip} className='status' style={{ color }}>
                    {letter}
                </div>
            </ScmInlineActions>
        </div >;
    }

    protected open = () => this.props.resource.open();

    protected selectChange = () => this.props.selectChange(this.props.resource);

    protected renderContextMenu = (event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        const { resource, contextKeys, contextMenuRenderer } = this.props;
        const currentScmResourceGroup = contextKeys.scmResourceGroup.get();
        contextKeys.scmResourceGroup.set(resource.group.id);
        try {
            contextMenuRenderer.render({
                menuPath: ScmWidget.RESOURCE_CONTEXT_MENU,
                anchor: event.nativeEvent,
                args: [resource] // TODO support multiselection
            });
        } finally {
            contextKeys.scmResourceGroup.set(currentScmResourceGroup);
        }
    }

}
export namespace ScmResourceComponent {
    export interface Props extends ScmWidget.Props {
        name: string;
        resource: ScmResource;
        selectChange: (change: ScmResource) => void;
    }
}

export class ScmResourceGroupsContainer extends React.Component<ScmResourceGroupsContainer.Props> {
    render() {
        const { groups } = this.props.repository.provider;
        return <div className={ScmWidget.Styles.GROUPS_CONTAINER} style={this.props.style} id={this.props.id} tabIndex={2}>
            {groups && this.props.repository.provider.groups.map(group => this.renderGroup(group))}
        </div>;
    }

    protected renderGroup(group: ScmResourceGroup): React.ReactNode {
        return group.resources.length && <ScmResourceGroupContainer
            key={group.id}
            repository={this.props.repository}
            group={group}
            selectChange={this.selectChange}
            contextMenuRenderer={this.props.contextMenuRenderer}
            commands={this.props.commands}
            menus={this.props.menus}
            contextKeys={this.props.contextKeys}
            labelProvider={this.props.labelProvider} />;
    }

    protected selectChange = (resource: ScmResource) => {
        this.props.repository.selectedResource = resource;
    }

    componentDidMount() {
        this.props.addScmListKeyListeners(this.props.id);
    }
}
export namespace ScmResourceGroupsContainer {
    export interface Props extends ScmWidget.Props {
        id: string;
        style?: React.CSSProperties;
        addScmListKeyListeners: (id: string) => void
    }
}

export class ScmResourceGroupContainer extends React.Component<ScmResourceGroupContainer.Props> {
    render() {
        const { group, menus, commands, contextKeys } = this.props;
        return <div className='changesContainer'>
            <div className='theia-header scm-theia-header' onContextMenu={this.renderContextMenu}>
                <div className='noWrapInfo'>{group.label}</div>
                <ScmInlineActions {...{
                    args: [group],
                    menu: menus.getMenu(ScmWidget.RESOURCE_GROUP_INLINE_MENU),
                    commands,
                    contextKeys,
                    group
                }}>
                    {this.renderChangeCount()}
                </ScmInlineActions>
            </div>
            <div>{group.resources.map(resource => this.renderScmResourceItem(resource))}</div>
        </div>;
    }

    protected renderContextMenu = (event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        const { group, contextKeys, contextMenuRenderer } = this.props;
        const currentScmResourceGroup = contextKeys.scmResourceGroup.get();
        contextKeys.scmResourceGroup.set(group.id);
        try {
            contextMenuRenderer.render({
                menuPath: ScmWidget.RESOURCE_GROUP_CONTEXT_MENU,
                anchor: event.nativeEvent,
                args: [group]
            });
        } finally {
            contextKeys.scmResourceGroup.set(currentScmResourceGroup);
        }
    }

    protected renderChangeCount(): React.ReactNode {
        const changeCount = this.props.group.resources.length;
        return !!changeCount && <div className='notification-count-container scm-change-count'>
            <span className='notification-count'>{changeCount}</span>
        </div>;
    }

    protected renderScmResourceItem(resource: ScmResource): React.ReactNode {
        const name = this.props.labelProvider.getName(resource.sourceUri);
        return <ScmResourceComponent
            key={String(resource.sourceUri)}
            name={name}
            resource={resource}
            repository={this.props.repository}
            commands={this.props.commands}
            menus={this.props.menus}
            contextKeys={this.props.contextKeys}
            labelProvider={this.props.labelProvider}
            selectChange={this.props.selectChange}
            contextMenuRenderer={this.props.contextMenuRenderer}
        />;
    }
}
export namespace ScmResourceGroupContainer {
    export interface Props extends ScmWidget.Props {
        group: ScmResourceGroup
        selectChange: (change: ScmResource) => void
    }
}

export class ScmInlineActions extends React.Component<ScmInlineActions.Props> {
    render(): React.ReactNode {
        const { menu, args, commands, group, contextKeys, children } = this.props;
        return <div className='theia-scm-inline-actions-container'>
            {!!menu.children.length && <div className='theia-scm-inline-actions'>
                {menu.children.map((node, index) => node instanceof ActionMenuNode && <ScmInlineAction key={index} {...{ node, args, commands, group, contextKeys }} />)}
            </div>}
            {children}
        </div>;
    }
}
export namespace ScmInlineActions {
    export interface Props {
        menu: CompositeMenuNode;
        commands: CommandRegistry;
        group: ScmResourceGroup;
        contextKeys: ScmContextKeyService;
        args: any[];
        children?: React.ReactNode;
    }
}

export class ScmInlineAction extends React.Component<ScmInlineAction.Props> {
    render(): React.ReactNode {
        const { node, args, commands, group, contextKeys } = this.props;
        const currentScmResourceGroup = contextKeys.scmResourceGroup.get();
        contextKeys.scmResourceGroup.set(group.id);
        try {
            if (!commands.isVisible(node.action.commandId, ...args) || !contextKeys.match(node.action.when)) {
                return false;
            }
            return <div className='theia-scm-inline-action'>
                <a className={node.icon} title={node.label} onClick={this.execute} />
            </div>;
        } finally {
            contextKeys.scmResourceGroup.set(currentScmResourceGroup);
        }
    }

    protected execute = () => {
        const { commands, node, args } = this.props;
        commands.executeCommand(node.action.commandId, ...args);
    }
}
export namespace ScmInlineAction {
    export interface Props {
        node: ActionMenuNode;
        commands: CommandRegistry;
        group: ScmResourceGroup;
        contextKeys: ScmContextKeyService;
        args: any[];
    }
}
