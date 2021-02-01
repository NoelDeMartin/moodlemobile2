// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { AfterViewInit, Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { IonContent } from '@ionic/angular';
import { AlertOptions } from '@ionic/core';
import { CoreEventObserver, CoreEvents } from '@singletons/events';
import { CoreSites } from '@services/sites';
import {
    AddonMessagesProvider,
    AddonMessagesConversationFormatted,
    AddonMessagesConversationMember,
    AddonMessagesGetMessagesMessage,
    AddonMessages,
    AddonMessagesMemberInfoChangedEventData,
    AddonMessagesSendInstantMessagesMessage,
    AddonMessagesSendMessagesToConversationMessage,
    AddonMessagesReadChangedEventData,
    AddonMessagesNewMessagedEventData,
    AddonMessagesUpdateConversationListEventData,
    AddonMessagesConversationMessageFormatted,
    AddonMessagesOpenConversationEventData,
} from '../../services/messages';
import { AddonMessagesOffline } from '../../services/messages-offline';
import { AddonMessagesSync, AddonMessagesSyncEvents, AddonMessagesSyncProvider } from '../../services/messages-sync';
import { CoreUser } from '@features/user/services/user';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreUtils } from '@services/utils/utils';
import { CoreTextUtils } from '@services/utils/text';
import { CoreLogger } from '@singletons/logger';
import { CoreApp } from '@services/app';
import { CoreInfiniteLoadingComponent } from '@components/infinite-loading/infinite-loading';
import { Md5 } from 'ts-md5/dist/md5';
import moment from 'moment';
import { CoreAnimations } from '@components/animations';
import { CoreError } from '@classes/errors/error';
import { ModalController, Translate } from '@singletons';
import { CoreNavigator } from '@services/navigator';
import { CoreIonLoadingElement } from '@classes/ion-loading';
import { ActivatedRoute } from '@angular/router';
import {
    AddonMessagesOfflineMessagesDBRecordFormatted,
} from '@addons/messages/services/database/messages';
import { AddonMessagesConversationInfoComponent } from '../../components/conversation-info/conversation-info';

/**
 * Page that displays a message discussion page.
 */
@Component({
    selector: 'page-addon-messages-discussion',
    templateUrl: 'discussion.html',
    animations: [CoreAnimations.SLIDE_IN_OUT],
    styleUrls: ['discussion.scss'],
})
export class AddonMessagesDiscussionPage implements OnInit, OnDestroy, AfterViewInit {

    @ViewChild(IonContent) content?: IonContent;
    @ViewChild(CoreInfiniteLoadingComponent) infinite?: CoreInfiniteLoadingComponent;

    siteId: string;
    protected fetching = false;
    protected polling?: NodeJS.Timeout;
    protected logger: CoreLogger;

    protected messagesBeingSent = 0;
    protected pagesLoaded = 1;
    protected lastMessage = { text: '', timecreated: 0 };
    protected keepMessageMap: {[hash: string]: boolean} = {};
    protected syncObserver: CoreEventObserver;
    protected oldContentHeight = 0;
    protected keyboardObserver: CoreEventObserver;
    protected scrollBottom = true;
    protected viewDestroyed = false;
    protected memberInfoObserver: CoreEventObserver;
    protected showLoadingModal = false; // Whether to show a loading modal while fetching data.

    conversationId?: number; // Conversation ID. Undefined if it's a new individual conversation.
    conversation?: AddonMessagesConversationFormatted; // The conversation object (if it exists).
    userId?: number; // User ID you're talking to (only if group messaging not enabled or it's a new individual conversation).
    currentUserId: number;
    title?: string;
    showInfo = false;
    conversationImage?: string;
    loaded = false;
    showKeyboard = false;
    canLoadMore = false;
    loadMoreError = false;
    messages: AddonMessagesConversationMessageFormatted[] = [];
    showDelete = false;
    canDelete = false;
    groupMessagingEnabled: boolean;
    isGroup = false;
    members: {[id: number]: AddonMessagesConversationMember} = {}; // Members that wrote a message, indexed by ID.
    favouriteIcon = 'fa-star';
    deleteIcon = 'fas-trash';
    blockIcon = 'fas-user-lock';
    addRemoveIcon = 'fas-user-plus';
    muteIcon = 'fas-bell-slash';
    favouriteIconSlash = false;
    muteEnabled = false;
    otherMember?: AddonMessagesConversationMember; // Other member information (individual conversations only).
    footerType: 'message' | 'blocked' | 'requiresContact' | 'requestSent' | 'requestReceived' | 'unable' = 'unable';
    requestContactSent = false;
    requestContactReceived = false;
    isSelf = false;
    newMessages = 0;
    scrollElement?: HTMLElement;
    unreadMessageFrom = 0;

    constructor(
        protected route: ActivatedRoute,
    ) {
        this.siteId = CoreSites.instance.getCurrentSiteId();
        this.currentUserId = CoreSites.instance.getCurrentSiteUserId();
        this.groupMessagingEnabled = AddonMessages.instance.isGroupMessagingEnabled();
        this.muteEnabled = AddonMessages.instance.isMuteConversationEnabled();

        this.logger = CoreLogger.getInstance('AddonMessagesDiscussionPage');

        // Refresh data if this discussion is synchronized automatically.
        this.syncObserver = CoreEvents.on<AddonMessagesSyncEvents>(AddonMessagesSyncProvider.AUTO_SYNCED, (data) => {
            if ((data.userId && data.userId == this.userId) ||
                    (data.conversationId && data.conversationId == this.conversationId)) {
                // Fetch messages.
                this.fetchMessages();

                // Show first warning if any.
                if (data.warnings && data.warnings[0]) {
                    CoreDomUtils.instance.showErrorModal(data.warnings[0]);
                }
            }
        }, this.siteId);

        // Refresh data if info of a mamber of the conversation have changed.
        this.memberInfoObserver = CoreEvents.on<AddonMessagesMemberInfoChangedEventData>(
            AddonMessagesProvider.MEMBER_INFO_CHANGED_EVENT,
            (data) => {
                if (data.userId && (this.members[data.userId] || this.otherMember && data.userId == this.otherMember.id)) {
                    this.fetchData();
                }
            },
            this.siteId,
        );

        // Recalculate footer position when keyboard is shown or hidden.
        this.keyboardObserver = CoreEvents.on(CoreEvents.KEYBOARD_CHANGE, () => {
            // @todo probably not needed.
            // this.content.resize();
        });
    }

    /**
     * Runs when the page has loaded. This event only happens once per page being created.
     * If a page leaves but is cached, then this event will not fire again on a subsequent viewing.
     * Setup code for the page.
     */
    async ngOnInit(): Promise<void> {
        // Disable the profile button if we're already coming from a profile.
        const backViewPage = CoreNavigator.instance.getPreviousPath();
        this.showInfo = !backViewPage || !CoreTextUtils.instance.matchesGlob(backViewPage, '**/user/profile');

        this.route.queryParams.subscribe(async (params) => {
            this.loaded = false;
            this.conversationId = CoreNavigator.instance.getRouteNumberParam('conversationId', params) || undefined;
            this.userId = CoreNavigator.instance.getRouteNumberParam('userId', params) || undefined;
            this.showKeyboard = CoreNavigator.instance.getRouteBooleanParam('showKeyboard', params) || false;

            await this.fetchData();

            this.scrollToBottom();
        });
    }

    /**
     * View has been initialized.
     */
    async ngAfterViewInit(): Promise<void> {
        this.scrollElement = await this.content?.getScrollElement();
    }

    /**
     * Adds a new message to the message list.
     *
     * @param message Message to be added.
     * @param keep If set the keep flag or not.
     * @return If message is not mine and was recently added.
     */
    protected addMessage(
        message: AddonMessagesConversationMessageFormatted,
        keep: boolean = true,
    ): boolean {

        /* Create a hash to identify the message. The text of online messages isn't reliable because it can have random data
           like VideoJS ID. Try to use id and fallback to text for offline messages. */
        const id = 'id' in message ? message.id : '';
        message.hash = Md5.hashAsciiStr(String(id || message.text || '')) + '#' + message.timecreated + '#' +
                message.useridfrom;

        let added = false;
        if (typeof this.keepMessageMap[message.hash] === 'undefined') {
            // Message not added to the list. Add it now.
            this.messages.push(message);
            added = message.useridfrom != this.currentUserId;
        }
        // Message needs to be kept in the list.
        this.keepMessageMap[message.hash] = keep;

        return added;
    }

    /**
     * Remove a message if it shouldn't be in the list anymore.
     *
     * @param hash Hash of the message to be removed.
     */
    protected removeMessage(hash: string): void {
        if (this.keepMessageMap[hash]) {
            // Selected to keep it, clear the flag.
            this.keepMessageMap[hash] = false;

            return;
        }

        delete this.keepMessageMap[hash];

        const position = this.messages.findIndex((message) => message.hash == hash);
        if (position >= 0) {
            this.messages.splice(position, 1);
        }
    }

    /**
     * Convenience function to fetch the conversation data.
     *
     * @return Resolved when done.
     */
    protected async fetchData(): Promise<void> {
        let loader: CoreIonLoadingElement | undefined;
        if (this.showLoadingModal) {
            loader = await CoreDomUtils.instance.showModalLoading();
        }

        if (!this.groupMessagingEnabled && this.userId) {
            // Get the user profile to retrieve the user fullname and image.
            CoreUser.instance.getProfile(this.userId, undefined, true).then((user) => {
                if (!this.title) {
                    this.title = user.fullname;
                }
                this.conversationImage = user.profileimageurl;

                return;
            }).catch(() => {
                // Ignore errors.
            });
        }

        // Synchronize messages if needed.
        try {
            const syncResult = await AddonMessagesSync.instance.syncDiscussion(this.conversationId, this.userId);
            if (syncResult.warnings && syncResult.warnings[0]) {
                CoreDomUtils.instance.showErrorModal(syncResult.warnings[0]);
            }
        } catch {
            // Ignore errors;
        }

        try {
            const promises: Promise<void>[] = [];
            if (this.groupMessagingEnabled) {
                // Get the conversation ID if it exists and we don't have it yet.
                const exists = await this.getConversation(this.conversationId, this.userId);

                if (exists) {
                    // Fetch the messages for the first time.
                    promises.push(this.fetchMessages());
                }

                if (this.userId) {
                    // Get the member info. Invalidate first to make sure we get the latest status.
                    promises.push(AddonMessages.instance.invalidateMemberInfo(this.userId).then(async () => {
                        this.otherMember = await AddonMessages.instance.getMemberInfo(this.userId!);

                        if (!exists && this.otherMember) {
                            this.conversationImage = this.otherMember.profileimageurl;
                            this.title = this.otherMember.fullname;
                        }
                        this.blockIcon = this.otherMember.isblocked ? 'fas-user-lock' : 'fas-user-check';

                        return;
                    }));
                } else {
                    this.otherMember = undefined;
                }

            } else {
                if (this.userId) {
                    // Fake the user member info.
                    promises.push(CoreUser.instance.getProfile(this.userId!).then(async (user) => {
                        this.otherMember = {
                            id: user.id,
                            fullname: user.fullname,
                            profileurl: '',
                            profileimageurl: user.profileimageurl || '',
                            profileimageurlsmall: user.profileimageurlsmall || '',
                            isonline: false,
                            showonlinestatus: false,
                            isblocked: false,
                            iscontact: false,
                            isdeleted: false,
                            canmessageevenifblocked: true,
                            canmessage: true,
                            requirescontact: false,
                        };
                        this.otherMember.isblocked = await AddonMessages.instance.isBlocked(this.userId!);
                        this.otherMember.iscontact = await AddonMessages.instance.isContact(this.userId!);
                        this.blockIcon = this.otherMember.isblocked ? 'fas-user-lock' : 'fas-user-check';

                        return;
                    }));


                }

                // Fetch the messages for the first time.
                promises.push(this.fetchMessages().then(() => {
                    if (!this.title && this.messages.length) {
                        // Didn't receive the fullname via argument. Try to get it from messages.
                        // It's possible that name cannot be resolved when no messages were yet exchanged.
                        const firstMessage = this.messages[0];
                        if ('usertofullname' in firstMessage) {
                            if (firstMessage.useridto != this.currentUserId) {
                                this.title = firstMessage.usertofullname || '';
                            } else {
                                this.title = firstMessage.userfromfullname || '';
                            }
                        }
                    }

                    return;
                }));
            }

            await Promise.all(promises);
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'addon.messages.errorwhileretrievingmessages', true);
        } finally {
            this.checkCanDelete();
            this.resizeContent();
            this.loaded = true;
            this.setPolling(); // Make sure we're polling messages.
            this.setContactRequestInfo();
            this.setFooterType();
            loader && loader.dismiss();
        }
    }

    /**
     * Runs when the page has fully entered and is now the active page.
     * This event will fire, whether it was the first load or a cached page.
     */
    ionViewDidEnter(): void {
        this.setPolling();
    }

    /**
     * Runs when the page is about to leave and no longer be the active page.
     */
    ionViewWillLeave(): void {
        this.unsetPolling();
    }

    /**
     * Convenience function to fetch messages.
     *
     * @param messagesAreNew If messages loaded are new messages.
     * @return Resolved when done.
     */
    protected async fetchMessages(messagesAreNew: boolean = true): Promise<void> {
        this.loadMoreError = false;

        if (this.messagesBeingSent > 0) {
            // We do not poll while a message is being sent or we could confuse the user.
            // Otherwise, his message would disappear from the list, and he'd have to wait for the interval to check for messages.
            return;
        } else if (this.fetching) {
            // Already fetching.
            return;
        } else if (this.groupMessagingEnabled && !this.conversationId) {
            // Don't have enough data to fetch messages.
            throw null;
        }

        if (this.conversationId) {
            this.logger.debug(`Polling new messages for conversation '${this.conversationId}'`);
        } else if (this.userId) {
            this.logger.debug(`Polling new messages for discussion with user '${this.userId}'`);
        } else {
            // Should not happen.
            throw null;
        }

        this.fetching = true;

        try {
            // Wait for synchronization process to finish.
            await AddonMessagesSync.instance.waitForSyncConversation(this.conversationId, this.userId);

            let messages: AddonMessagesConversationMessageFormatted[] = [];
            // Fetch messages. Invalidate the cache before fetching.
            if (this.groupMessagingEnabled) {
                await AddonMessages.instance.invalidateConversationMessages(this.conversationId!);
                messages =  await this.getConversationMessages(this.pagesLoaded);
            } else {
                await AddonMessages.instance.invalidateDiscussionCache(this.userId!);
                messages = await this.getDiscussionMessages(this.pagesLoaded);
            }

            this.loadMessages(messages, messagesAreNew);

        } finally {
            this.fetching = false;
        }
    }

    /**
     * Format and load a list of messages into the view.
     *
     * @param messagesAreNew If messages loaded are new messages.
     * @param messages Messages to load.
     */
    protected loadMessages(
        messages: AddonMessagesConversationMessageFormatted[],
        messagesAreNew: boolean = true,
    ): void {

        if (this.viewDestroyed) {
            return;
        }

        // Don't use domUtils.getScrollHeight because it gives an outdated value after receiving a new message.
        const scrollHeight = this.scrollElement ? this.scrollElement.scrollHeight : 0;

        // Check if we are at the bottom to scroll it after render.
        // Use a 5px error margin because in iOS there is 1px difference for some reason.
        this.scrollBottom = Math.abs(scrollHeight - (this.scrollElement?.scrollTop || 0) -
            (this.scrollElement?.clientHeight || 0)) < 5;

        if (this.messagesBeingSent > 0) {
            // Ignore polling due to a race condition.
            return;
        }

        // Add new messages to the list and mark the messages that should still be displayed.
        const newMessages = messages.reduce((val, message) => val + (this.addMessage(message) ? 1 : 0), 0);

        // Set the new badges message if we're loading new messages.
        if (messagesAreNew) {
            this.setNewMessagesBadge(this.newMessages + newMessages);
        }

        // Remove messages that shouldn't be in the list anymore.
        for (const hash in this.keepMessageMap) {
            this.removeMessage(hash);
        }

        // Sort the messages.
        AddonMessages.instance.sortMessages(this.messages);

        // Calculate which messages need to display the date or user data.
        this.messages.forEach((message, index) => {
            message.showDate = this.showDate(message, this.messages[index - 1]);
            message.showUserData = this.showUserData(message, this.messages[index - 1]);
            message.showTail = this.showTail(message, this.messages[index + 1]);
        });

        // Call resize to recalculate the dimensions.
        // @todo probably not needed.
        // this.content!.resize();

        // If we received a new message while using group messaging, force mark messages as read.
        const last = this.messages[this.messages.length - 1];
        const forceMark = this.groupMessagingEnabled && last && last.useridfrom != this.currentUserId && this.lastMessage.text != ''
                    && (last.text !== this.lastMessage.text || last.timecreated !== this.lastMessage.timecreated);

        // Notify that there can be a new message.
        this.notifyNewMessage();

        // Mark retrieved messages as read if they are not.
        this.markMessagesAsRead(forceMark);
    }

    /**
     * Set the new message badge number and set scroll listener if needed.
     *
     * @param addMessages NUmber of messages still to be read.
     */
    protected setNewMessagesBadge(addMessages: number): void {
        if (this.newMessages == 0 && addMessages > 0) {
            // Setup scrolling.
            this.content!.scrollEvents = true;

            this.scrollFunction();
        } else if (this.newMessages > 0 && addMessages == 0) {
            // Remove scrolling.
            this.content!.scrollEvents = false;
        }

        this.newMessages = addMessages;
    }

    /**
     * The scroll was moved. Update new messages count.
     */
    scrollFunction(): void {
        if (this.newMessages > 0) {
            const scrollBottom = (this.scrollElement?.scrollTop || 0) + (this.scrollElement?.clientHeight || 0);
            const scrollHeight = (this.scrollElement?.scrollHeight || 0);
            if (scrollBottom > scrollHeight - 40) {
                // At the bottom, reset.
                this.setNewMessagesBadge(0);

                return;
            }

            const scrollElRect = this.scrollElement?.getBoundingClientRect();
            const scrollBottomPos = (scrollElRect && scrollElRect.bottom) || 0;

            if (scrollBottomPos == 0) {
                return;
            }

            const messages = Array.from(document.querySelectorAll('.addon-message-not-mine')).slice(-this.newMessages).reverse();

            const newMessagesUnread = messages.findIndex((message) => {
                const elementRect = message.getBoundingClientRect();
                if (!elementRect) {
                    return false;
                }

                return elementRect.bottom <= scrollBottomPos;
            });

            if (newMessagesUnread > 0 && newMessagesUnread < this.newMessages) {
                this.setNewMessagesBadge(newMessagesUnread);
            }
        }
    }

    /**
     * Get the conversation.
     *
     * @param conversationId Conversation ID.
     * @param userId User ID.
     * @return Promise resolved with a boolean: whether the conversation exists or not.
     */
    protected async getConversation(conversationId?: number, userId?: number): Promise<boolean> {
        let fallbackConversation: AddonMessagesConversationFormatted | undefined;

        // Try to get the conversationId if we don't have it.
        if (!conversationId && userId) {
            try {
                if (userId == this.currentUserId && AddonMessages.instance.isSelfConversationEnabled()) {
                    fallbackConversation = await AddonMessages.instance.getSelfConversation();
                } else {
                    fallbackConversation = await AddonMessages.instance.getConversationBetweenUsers(userId, undefined, true);
                }
                conversationId = fallbackConversation.id;
            } catch (error) {
                // Probably conversation does not exist or user is offline. Try to load offline messages.
                this.isSelf = userId == this.currentUserId;

                const messages = await AddonMessagesOffline.instance.getMessages(userId);

                if (messages && messages.length) {
                // We have offline messages, this probably means that the conversation didn't exist. Don't display error.
                    messages.forEach((message) => {
                        message.pending = true;
                        message.text = message.smallmessage;
                    });

                    this.loadMessages(messages);
                } else if (error.errorcode != 'errorconversationdoesnotexist') {
                    // Display the error.
                    throw error;
                }

                return false;
            }
        }


        // Retrieve the conversation. Invalidate data first to get the right unreadcount.
        await AddonMessages.instance.invalidateConversation(conversationId!);

        try {
            this.conversation = await AddonMessages.instance.getConversation(conversationId!, undefined, true);
        } catch (error) {
            // Get conversation failed, use the fallback one if we have it.
            if (fallbackConversation) {
                this.conversation = fallbackConversation;
            } else {
                throw error;
            }
        }

        if (this.conversation) {
            this.conversationId = this.conversation.id;
            this.title = this.conversation.name;
            this.conversationImage = this.conversation.imageurl;
            this.isGroup = this.conversation.type == AddonMessagesProvider.MESSAGE_CONVERSATION_TYPE_GROUP;
            this.favouriteIcon = 'fas-star';
            this.favouriteIconSlash = this.conversation.isfavourite;
            this.muteIcon = this.conversation.ismuted ? 'fas-bell' : 'fas-bell-slash';
            if (!this.isGroup) {
                this.userId = this.conversation.userid;
            }
            this.isSelf = this.conversation.type == AddonMessagesProvider.MESSAGE_CONVERSATION_TYPE_SELF;

            return true;
        } else {
            return false;
        }

    }

    /**
     * Get the messages of the conversation. Used if group messaging is supported.
     *
     * @param pagesToLoad Number of "pages" to load.
     * @param offset Offset for message list.
     * @return Promise resolved with the list of messages.
     */
    protected async getConversationMessages(
        pagesToLoad: number,
        offset: number = 0,
    ): Promise<AddonMessagesConversationMessageFormatted[]> {

        if (!this.conversationId) {
            return [];
        }

        const excludePending = offset > 0;

        const result = await AddonMessages.instance.getConversationMessages(this.conversationId, {
            excludePending: excludePending,
            limitFrom: offset,
        });

        pagesToLoad--;

        // Treat members. Don't use CoreUtilsProvider.arrayToObject because we don't want to override the existing object.
        if (result.members) {
            result.members.forEach((member) => {
                this.members[member.id] = member;
            });
        }

        const messages: AddonMessagesConversationMessageFormatted[] = result.messages;

        if (pagesToLoad > 0 && result.canLoadMore) {
            offset += AddonMessagesProvider.LIMIT_MESSAGES;

            // Get more messages.
            const nextMessages = await this.getConversationMessages(pagesToLoad, offset);

            return messages.concat(nextMessages);
        }

        // No more messages to load, return them.
        this.canLoadMore = !!result.canLoadMore;

        return messages;

    }

    /**
     * Get a discussion. Can load several "pages".
     *
     * @param pagesToLoad Number of pages to load.
     * @param lfReceivedUnread Number of unread received messages already fetched, so fetch will be done from this.
     * @param lfReceivedRead Number of read received messages already fetched, so fetch will be done from this.
     * @param lfSentUnread Number of unread sent messages already fetched, so fetch will be done from this.
     * @param lfSentRead Number of read sent messages already fetched, so fetch will be done from this.
     * @return Resolved when done.
     */
    protected async getDiscussionMessages(
        pagesToLoad: number,
        lfReceivedUnread: number = 0,
        lfReceivedRead: number = 0,
        lfSentUnread: number = 0,
        lfSentRead: number = 0,
    ): Promise<(AddonMessagesGetMessagesMessage | AddonMessagesOfflineMessagesDBRecordFormatted)[]> {

        // Only get offline messages if we're loading the first "page".
        const excludePending = lfReceivedUnread > 0 || lfReceivedRead > 0 || lfSentUnread > 0 || lfSentRead > 0;

        // Get next messages.
        const result = await AddonMessages.instance.getDiscussion(
            this.userId!,
            excludePending,
            lfReceivedUnread,
            lfReceivedRead,
            lfSentUnread,
            lfSentRead,
        );

        pagesToLoad--;
        if (pagesToLoad > 0 && result.canLoadMore) {
            // More pages to load. Calculate new limit froms.
            result.messages.forEach((message) => {
                if (!message.pending && 'read' in message) {
                    if (message.useridfrom == this.userId) {
                        if (message.read) {
                            lfReceivedRead++;
                        } else {
                            lfReceivedUnread++;
                        }
                    } else {
                        if (message.read) {
                            lfSentRead++;
                        } else {
                            lfSentUnread++;
                        }
                    }
                }
            });

            // Get next messages.
            const nextMessages =
                await this.getDiscussionMessages(pagesToLoad, lfReceivedUnread, lfReceivedRead, lfSentUnread, lfSentRead);

            return result.messages.concat(nextMessages);
        } else {
            // No more messages to load, return them.
            this.canLoadMore = result.canLoadMore;

            return result.messages;
        }
    }

    /**
     * Mark messages as read.
     */
    protected async markMessagesAsRead(forceMark: boolean): Promise<void> {
        let readChanged = false;

        if (AddonMessages.instance.isMarkAllMessagesReadEnabled()) {
            let messageUnreadFound = false;

            // Mark all messages at a time if there is any unread message.
            if (forceMark) {
                messageUnreadFound = true;
            } else if (this.groupMessagingEnabled) {
                messageUnreadFound = !!((this.conversation?.unreadcount && this.conversation?.unreadcount > 0) &&
                    (this.conversationId && this.conversationId > 0));
            } else {
                // If an unread message is found, mark all messages as read.
                messageUnreadFound = this.messages.some((message) =>
                    message.useridfrom != this.currentUserId && ('read' in message && !message.read));
            }

            if (messageUnreadFound) {
                this.setUnreadLabelPosition();

                if (this.groupMessagingEnabled) {
                    await AddonMessages.instance.markAllConversationMessagesRead(this.conversationId!);
                } else {
                    await AddonMessages.instance.markAllMessagesRead(this.userId);

                    // Mark all messages as read.
                    this.messages.forEach((message) => {
                        if ('read' in message) {
                            message.read = true;
                        }
                    });
                }

                readChanged = true;
            }
        } else {
            this.setUnreadLabelPosition();
            const promises: Promise<void>[] = [];

            // Mark each message as read one by one.
            this.messages.forEach((message) => {
                // If the message is unread, call AddonMessages.instance.markMessageRead.
                if (message.useridfrom != this.currentUserId && 'read' in message && !message.read) {
                    promises.push(AddonMessages.instance.markMessageRead(message.id).then(() => {
                        readChanged = true;
                        message.read = true;

                        return;
                    }));
                }
            });

            await Promise.all(promises);
        }

        if (readChanged) {
            CoreEvents.trigger<AddonMessagesReadChangedEventData>(AddonMessagesProvider.READ_CHANGED_EVENT, {
                conversationId: this.conversationId,
                userId: this.userId,
            }, this.siteId);
        }
    }

    /**
     * Notify the last message found so discussions list controller can tell if last message should be updated.
     */
    protected notifyNewMessage(): void {
        const last = this.messages[this.messages.length - 1];

        let trigger = false;

        if (!last) {
            this.lastMessage = { text: '', timecreated: 0 };
            trigger = true;
        } else if (last.text !== this.lastMessage.text || last.timecreated !== this.lastMessage.timecreated) {
            this.lastMessage = { text: last.text || '', timecreated: last.timecreated };
            trigger = true;
        }

        if (trigger) {
            // Update discussions last message.
            CoreEvents.trigger<AddonMessagesNewMessagedEventData>(AddonMessagesProvider.NEW_MESSAGE_EVENT, {
                conversationId: this.conversationId,
                userId: this.userId,
                message: this.lastMessage.text,
                timecreated: this.lastMessage.timecreated,
                isfavourite: !!this.conversation?.isfavourite,
                type: this.conversation?.type,
            }, this.siteId);

            // Update navBar links and buttons.
            const newCanDelete = (last && 'id' in last && last.id && this.messages.length == 1) || this.messages.length > 1;
            if (this.canDelete != newCanDelete) {
                this.checkCanDelete();
            }
        }
    }

    /**
     * Set the place where the unread label position has to be.
     */
    protected setUnreadLabelPosition(): void {
        if (this.unreadMessageFrom != 0) {
            return;
        }

        if (this.groupMessagingEnabled) {
            // Use the unreadcount from the conversation to calculate where should the label be placed.
            if (this.conversation && (this.conversation?.unreadcount && this.conversation?.unreadcount > 0) && this.messages) {
                // Iterate over messages to find the right message using the unreadcount. Skip offline messages and own messages.
                let found = 0;

                for (let i = this.messages.length - 1; i >= 0; i--) {
                    const message = this.messages[i];
                    if (!message.pending && message.useridfrom != this.currentUserId && 'id' in message) {
                        found++;
                        if (found == this.conversation.unreadcount) {
                            this.unreadMessageFrom = Number(message.id);
                            break;
                        }
                    }
                }
            }
        } else {
            let previousMessageRead = false;

            for (const x in this.messages) {
                const message = this.messages[x];
                if (message.useridfrom != this.currentUserId && 'read' in message) {
                    const unreadFrom = !message.read && previousMessageRead;

                    if (unreadFrom) {
                        // Save where the label is placed.
                        this.unreadMessageFrom = Number(message.id);
                        break;
                    }

                    previousMessageRead = !!message.read;
                }
            }
        }

        // Do not update the message unread from label on next refresh.
        if (this.unreadMessageFrom == 0) {
            // Using negative to indicate the label is not placed but should not be placed.
            this.unreadMessageFrom = -1;
        }
    }

    /**
     * Check if there's any message in the list that can be deleted.
     */
    protected checkCanDelete(): void {
        // All messages being sent should be at the end of the list.
        const first = this.messages[0];
        this.canDelete = first && !first.sending;
    }

    /**
     * Hide unread label when sending messages.
     */
    protected hideUnreadLabel(): void {
        if (this.unreadMessageFrom > 0) {
            this.unreadMessageFrom = -1;
        }
    }

    /**
     * Wait until fetching is false.
     *
     * @return Resolved when done.
     */
    protected waitForFetch(): Promise<void> {
        if (!this.fetching) {
            return Promise.resolve();
        }

        const deferred = CoreUtils.instance.promiseDefer<void>();

        setTimeout(() => this.waitForFetch().finally(() => {
            deferred.resolve();
        }), 400);

        return deferred.promise;
    }

    /**
     * Set a polling to get new messages every certain time.
     */
    protected setPolling(): void {
        if (this.groupMessagingEnabled && !this.conversationId) {
            // Don't have enough data to poll messages.
            return;
        }

        if (!this.polling) {
            // Start polling.
            this.polling = setInterval(() => {
                this.fetchMessages().catch(() => {
                    // Ignore errors.
                });
            }, AddonMessagesProvider.POLL_INTERVAL);
        }
    }

    /**
     * Unset polling.
     */
    protected unsetPolling(): void {
        if (this.polling) {
            this.logger.debug(`Cancelling polling for conversation with user '${this.userId}'`);
            clearInterval(this.polling);
            this.polling = undefined;
        }
    }

    /**
     * Copy message to clipboard.
     *
     * @param message Message to be copied.
     */
    copyMessage(message: AddonMessagesConversationMessageFormatted): void {
        const text = 'smallmessage' in message ? message.smallmessage || message.text || '' : message.text || '';
        CoreUtils.instance.copyToClipboard(CoreTextUtils.instance.decodeHTMLEntities(text));
    }

    /**
     * Function to delete a message.
     *
     * @param message Message object to delete.
     * @param index Index where the message is to delete it from the view.
     */
    async deleteMessage(
        message: AddonMessagesConversationMessageFormatted,
        index: number,
    ): Promise<void> {

        const canDeleteAll = this.conversation && this.conversation.candeletemessagesforallusers;
        const langKey = message.pending || canDeleteAll || this.isSelf ? 'core.areyousure' :
            'addon.messages.deletemessageconfirmation';
        const options: AlertOptions = {};

        if (canDeleteAll && !message.pending) {
            // Show delete for all checkbox.
            options.inputs = [{
                type: 'checkbox',
                name: 'deleteforall',
                checked: false,
                value: true,
                label: Translate.instance.instant('addon.messages.deleteforeveryone'),
            }];
        }

        try {
            const data: boolean[] = await CoreDomUtils.instance.showConfirm(
                Translate.instance.instant(langKey),
                undefined,
                undefined,
                undefined,
                options,
            );

            const modal = await CoreDomUtils.instance.showModalLoading('core.deleting', true);

            try {
                await AddonMessages.instance.deleteMessage(message, data && data[0]);
                // Remove message from the list without having to wait for re-fetch.
                this.messages.splice(index, 1);
                this.removeMessage(message.hash!);
                this.notifyNewMessage();

                this.fetchMessages(); // Re-fetch messages to update cached data.
            } finally {
                modal.dismiss();
            }
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'addon.messages.errordeletemessage', true);
        }
    }

    /**
     * Function to load previous messages.
     *
     * @param infiniteComplete Infinite scroll complete function. Only used from core-infinite-loading.
     * @return Resolved when done.
     */
    async loadPrevious(infiniteComplete?: () => void): Promise<void> {
        let infiniteHeight = this.infinite?.infiniteEl?.nativeElement.getBoundingClientRect().height || 0;
        const scrollHeight = (this.scrollElement?.scrollHeight || 0);

        // If there is an ongoing fetch, wait for it to finish.
        try {
            await this.waitForFetch();
        } finally {
            this.pagesLoaded++;

            try {
                await this.fetchMessages(false);

                // Try to keep the scroll position.
                const scrollBottom = scrollHeight - (this.scrollElement?.scrollTop || 0);

                const height = this.infinite?.infiniteEl?.nativeElement.getBoundingClientRect().height || 0;
                if (this.canLoadMore && infiniteHeight && this.infinite) {
                    // The height of the infinite is different while spinner is shown. Add that difference.
                    infiniteHeight = infiniteHeight - height;
                } else if (!this.canLoadMore) {
                    // Can't load more, take into account the full height of the infinite loading since it will disappear now.
                    infiniteHeight = infiniteHeight || height;
                }

                this.keepScroll(scrollHeight, scrollBottom, infiniteHeight);
            } catch (error) {
                this.loadMoreError = true; // Set to prevent infinite calls with infinite-loading.
                this.pagesLoaded--;
                CoreDomUtils.instance.showErrorModalDefault(error, 'addon.messages.errorwhileretrievingmessages', true);
            } finally {
                infiniteComplete && infiniteComplete();
            }
        }
    }

    /**
     * Keep scroll position after loading previous messages.
     * We don't use resizeContent because the approach used is different and it isn't easy to calculate these positions.
     */
    protected keepScroll(oldScrollHeight: number, oldScrollBottom: number, infiniteHeight: number, retries = 0): void {

        setTimeout(() => {
            const newScrollHeight = (this.scrollElement?.scrollHeight || 0);

            if (newScrollHeight == oldScrollHeight) {
                // Height hasn't changed yet. Retry if max retries haven't been reached.
                if (retries <= 10) {
                    this.keepScroll(oldScrollHeight, oldScrollBottom, infiniteHeight, retries + 1);
                }

                return;
            }

            const scrollTo = newScrollHeight - oldScrollBottom + infiniteHeight;

            this.content!.scrollToPoint(0, scrollTo, 0);
        }, 30);
    }

    /**
     * Content or scroll has been resized. For content, only call it if it's been added on top.
     */
    resizeContent(): void {
        /* @todo probably not needed.
        let top = this.content!.getContentDimensions().scrollTop;
        // @todo this.content.resize();

        // Wait for new content height to be calculated.
        setTimeout(() => {
            // Visible content size changed, maintain the bottom position.
            if (!this.viewDestroyed && (this.scrollElement?.clientHeight || 0) != this.oldContentHeight) {
                if (!top) {
                    top = this.content!.getContentDimensions().scrollTop;
                }

                top += this.oldContentHeight - (this.scrollElement?.clientHeight || 0);
                this.oldContentHeight = (this.scrollElement?.clientHeight || 0);

                this.content!.scrollToPoint(0, top, 0);
            }
        });
        */
    }

    /**
     * Scroll bottom when render has finished.
     */
    scrollToBottom(): void {
        // Check if scroll is at bottom. If so, scroll bottom after rendering since there might be something new.
        if (this.scrollBottom) {
            // Need a timeout to leave time to the view to be rendered.
            setTimeout(() => {
                if (!this.viewDestroyed) {
                    this.content!.scrollToBottom(0);
                }
            });
            this.scrollBottom = false;

            // Reset the badge.
            this.setNewMessagesBadge(0);
        }
    }

    /**
     * Scroll to the first new unread message.
     */
    scrollToFirstUnreadMessage(): void {
        if (this.newMessages > 0) {
            const messages = Array.from(document.querySelectorAll('.addon-message-not-mine'));

            CoreDomUtils.instance.scrollToElement(this.content!, <HTMLElement> messages[messages.length - this.newMessages]);
        }
    }

    /**
     * Sends a message to the server.
     *
     * @param text Message text.
     */
    async sendMessage(text: string): Promise<void> {
        this.hideUnreadLabel();

        this.showDelete = false;
        this.scrollBottom = true;
        this.setNewMessagesBadge(0);

        const message: AddonMessagesConversationMessageFormatted = {
            id: -1,
            pending: true,
            sending: true,
            useridfrom: this.currentUserId,
            smallmessage: text,
            text: text,
            timecreated: new Date().getTime(),
        };
        message.showDate = this.showDate(message, this.messages[this.messages.length - 1]);
        this.addMessage(message, false);

        this.messagesBeingSent++;

        // If there is an ongoing fetch, wait for it to finish.
        // Otherwise, if a message is sent while fetching it could disappear until the next fetch.
        try {
            await this.waitForFetch();
        } finally {

            try {
                let data: {
                    sent: boolean;
                    message: AddonMessagesSendMessagesToConversationMessage | AddonMessagesSendInstantMessagesMessage;
                };
                if (this.conversationId) {
                    data = await AddonMessages.instance.sendMessageToConversation(this.conversation!, text);
                } else {
                    data = await AddonMessages.instance.sendMessage(this.userId!, text);
                }


                this.messagesBeingSent--;
                let failure = false;
                if (data.sent) {
                    try {

                        if (!this.conversationId && data.message && 'conversationid' in data.message) {
                            // Message sent to a new conversation, try to load the conversation.
                            await this.getConversation(data.message.conversationid, this.userId);
                            // Now fetch messages.
                            try {
                                await this.fetchMessages();
                            } finally {
                                // Start polling messages now that the conversation exists.
                                this.setPolling();
                            }
                        } else {
                            // Message was sent, fetch messages right now.
                            await this.fetchMessages();
                        }
                    } catch {
                        failure = true;
                    }
                }

                if (failure || !data.sent) {
                    // Fetch failed or is offline message, mark the message as sent.
                    // If fetch is successful there's no need to mark it because the fetch will already show the message received.
                    message.sending = false;
                    if (data.sent) {
                        // Message sent to server, not pending anymore.
                        message.pending = false;
                    } else if (data.message) {
                        message.timecreated = data.message.timecreated || 0;
                    }

                    this.notifyNewMessage();
                }

            } catch (error) {
                this.messagesBeingSent--;

                // Only close the keyboard if an error happens.
                // We want the user to be able to send multiple messages without the keyboard being closed.
                CoreApp.instance.closeKeyboard();

                CoreDomUtils.instance.showErrorModalDefault(error, 'addon.messages.messagenotsent', true);
                this.removeMessage(message.hash!);
            }
        }
    }

    /**
     * Check date should be shown on message list for the current message.
     * If date has changed from previous to current message it should be shown.
     *
     * @param message Current message where to show the date.
     * @param prevMessage Previous message where to compare the date with.
     * @return If date has changed and should be shown.
     */
    showDate(
        message: AddonMessagesConversationMessageFormatted,
        prevMessage?: AddonMessagesConversationMessageFormatted,
    ): boolean {

        if (!prevMessage) {
            // First message, show it.
            return true;
        }

        // Check if day has changed.
        return !moment(message.timecreated).isSame(prevMessage.timecreated, 'day');
    }

    /**
     * Check if the user info should be displayed for the current message.
     * User data is only displayed for group conversations if the previous message was from another user.
     *
     * @param message Current message where to show the user info.
     * @param prevMessage Previous message.
     * @return Whether user data should be shown.
     */
    showUserData(
        message: AddonMessagesConversationMessageFormatted,
        prevMessage?: AddonMessagesConversationMessageFormatted,
    ): boolean {

        return this.isGroup && message.useridfrom != this.currentUserId && this.members[(message.useridfrom || 0)] &&
            (!prevMessage || prevMessage.useridfrom != message.useridfrom || !!message.showDate);
    }

    /**
     * Check if a css tail should be shown.
     *
     * @param message Current message where to show the user info.
     * @param nextMessage Next message.
     * @return Whether user data should be shown.
     */
    showTail(
        message: AddonMessagesConversationMessageFormatted,
        nextMessage?: AddonMessagesConversationMessageFormatted,
    ): boolean {
        return !nextMessage || nextMessage.useridfrom != message.useridfrom || !!nextMessage.showDate;
    }

    /**
     * Toggles delete state.
     */
    toggleDelete(): void {
        this.showDelete = !this.showDelete;
    }

    /**
     * View info. If it's an individual conversation, go to the user profile.
     * If it's a group conversation, view info about the group.
     */
    async viewInfo(): Promise<void> {
        if (this.isGroup) {
            // Display the group information.
            const modal = await ModalController.instance.create({
                component: AddonMessagesConversationInfoComponent,
                componentProps: {
                    conversationId: this.conversationId,
                },
            });

            await modal.present();

            const result = await modal.onDidDismiss();

            if (typeof result.data != 'undefined') {
                const splitViewLoaded = CoreNavigator.instance.isCurrentPathInTablet('**/messages/**/discussion');

                // Open user conversation.
                if (splitViewLoaded) {
                    // Notify the left pane to load it, this way the right conversation will be highlighted.
                    CoreEvents.trigger<AddonMessagesOpenConversationEventData>(
                        AddonMessagesProvider.OPEN_CONVERSATION_EVENT,
                        { userId: result.data },
                        this.siteId,
                    );
                } else {
                    // Open the discussion in a new view.
                    CoreNavigator.instance.navigateToSitePath('/messages/discussion', { params: { userId: result.data.userId } });
                }
            }
        } else {
            // Open the user profile.
            CoreNavigator.instance.navigateToSitePath('/user/profile', { params: { userId: this.userId } });
        }
    }

    /**
     * Change the favourite state of the current conversation.
     *
     * @param done Function to call when done.
     */
    async changeFavourite(done?: () => void): Promise<void> {
        if (!this.conversation) {
            return;
        }

        this.favouriteIcon = 'spinner';

        try {
            await AddonMessages.instance.setFavouriteConversation(this.conversation.id, !this.conversation.isfavourite);

            this.conversation.isfavourite = !this.conversation.isfavourite;

            // Get the conversation data so it's cached. Don't block the user for this.
            AddonMessages.instance.getConversation(this.conversation.id, undefined, true);

            CoreEvents.trigger<AddonMessagesUpdateConversationListEventData>(AddonMessagesProvider.UPDATE_CONVERSATION_LIST_EVENT, {
                conversationId: this.conversation.id,
                action: 'favourite',
                value: this.conversation.isfavourite,
            }, this.siteId);
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'Error changing favourite state.');
        } finally {
            this.favouriteIcon = 'fas-star';
            this.favouriteIconSlash = this.conversation.isfavourite;
            done && done();
        }
    }

    /**
     * Change the mute state of the current conversation.
     *
     * @param done Function to call when done.
     */
    async changeMute(done?: () => void): Promise<void> {
        if (!this.conversation) {
            return;
        }

        this.muteIcon = 'spinner';

        try {
            await AddonMessages.instance.muteConversation(this.conversation.id, !this.conversation.ismuted);
            this.conversation.ismuted = !this.conversation.ismuted;

            // Get the conversation data so it's cached. Don't block the user for this.
            AddonMessages.instance.getConversation(this.conversation.id, undefined, true);

            CoreEvents.trigger<AddonMessagesUpdateConversationListEventData>(AddonMessagesProvider.UPDATE_CONVERSATION_LIST_EVENT, {
                conversationId: this.conversation.id,
                action: 'mute',
                value: this.conversation.ismuted,
            }, this.siteId);

        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'Error changing muted state.');
        } finally {
            this.muteIcon = this.conversation.ismuted ? 'fas-bell' : 'fas-bell-slash';
            done && done();
        }
    }

    /**
     * Calculate whether there are pending contact requests.
     */
    protected setContactRequestInfo(): void {
        this.requestContactSent = false;
        this.requestContactReceived = false;
        if (this.otherMember && !this.otherMember.iscontact) {
            this.requestContactSent = !!this.otherMember.contactrequests?.some((request) =>
                request.userid == this.currentUserId && request.requesteduserid == this.otherMember!.id);
            this.requestContactReceived = !!this.otherMember.contactrequests?.some((request) =>
                request.userid == this.otherMember!.id && request.requesteduserid == this.currentUserId);
        }
    }

    /**
     * Calculate what to display in the footer.
     */
    protected setFooterType(): void {
        if (!this.otherMember) {
            // Group conversation or group messaging not available.
            this.footerType = 'message';
        } else if (this.otherMember.isblocked) {
            this.footerType = 'blocked';
        } else if (this.requestContactReceived) {
            this.footerType = 'requestReceived';
        } else if (this.otherMember.canmessage) {
            this.footerType = 'message';
        } else if (this.requestContactSent) {
            this.footerType = 'requestSent';
        } else if (this.otherMember.requirescontact) {
            this.footerType = 'requiresContact';
        } else {
            this.footerType = 'unable';
        }
    }

    /**
     * Displays a confirmation modal to block the user of the individual conversation.
     *
     * @return Promise resolved when user is blocked or dialog is cancelled.
     */
    async blockUser(): Promise<void> {
        if (!this.otherMember) {
            // Should never happen.
            throw new CoreError('No member selected to be blocked.');
        }

        const template = Translate.instance.instant('addon.messages.blockuserconfirm', { $a: this.otherMember.fullname });
        const okText = Translate.instance.instant('addon.messages.blockuser');

        try {
            await CoreDomUtils.instance.showConfirm(template, undefined, okText);
            this.blockIcon = 'spinner';

            const modal = await CoreDomUtils.instance.showModalLoading('core.sending', true);
            this.showLoadingModal = true;

            try {
                try {
                    await AddonMessages.instance.blockContact(this.otherMember.id);
                } finally {
                    modal.dismiss();
                    this.showLoadingModal = false;
                }
            } catch (error) {
                CoreDomUtils.instance.showErrorModalDefault(error, 'core.error', true);
            } finally {
                this.blockIcon = this.otherMember.isblocked ? 'fas-user-lock' : 'fas-user-check';
            }
        } catch {
            // User cancelled.
        }
    }

    /**
     * Delete the conversation.
     *
     * @param done Function to call when done.
     */
    async deleteConversation(done?: () => void): Promise<void> {
        if (!this.conversation) {
            return;
        }

        const confirmMessage = 'addon.messages.' + (this.isSelf ? 'deleteallselfconfirm' : 'deleteallconfirm');

        try {
            await CoreDomUtils.instance.showDeleteConfirm(confirmMessage);
            this.deleteIcon = 'spinner';

            try {
                try {
                    await AddonMessages.instance.deleteConversation(this.conversation.id);

                    CoreEvents.trigger<AddonMessagesUpdateConversationListEventData>(
                        AddonMessagesProvider.UPDATE_CONVERSATION_LIST_EVENT,
                        {
                            conversationId: this.conversation.id,
                            action: 'delete',
                        },
                        this.siteId,
                    );

                    this.messages = [];
                } finally {
                    done && done();
                }
            } catch (error) {
                CoreDomUtils.instance.showErrorModalDefault(error, 'Error deleting conversation.');
            } finally {
                this.deleteIcon = 'fas-trash';
            }
        } catch {
            // User cancelled.
        }
    }

    /**
     * Displays a confirmation modal to unblock the user of the individual conversation.
     *
     * @return Promise resolved when user is unblocked or dialog is cancelled.
     */
    async unblockUser(): Promise<void> {
        if (!this.otherMember) {
            // Should never happen.
            throw new CoreError('No member selected to be unblocked.');
        }

        const template = Translate.instance.instant('addon.messages.unblockuserconfirm', { $a: this.otherMember.fullname });
        const okText = Translate.instance.instant('addon.messages.unblockuser');

        try {
            await CoreDomUtils.instance.showConfirm(template, undefined, okText);

            this.blockIcon = 'spinner';

            const modal = await CoreDomUtils.instance.showModalLoading('core.sending', true);
            this.showLoadingModal = true;

            try {
                try {
                    await AddonMessages.instance.unblockContact(this.otherMember.id);
                } finally {
                    modal.dismiss();
                    this.showLoadingModal = false;
                }
            } catch (error) {
                CoreDomUtils.instance.showErrorModalDefault(error, 'core.error', true);
            } finally {
                this.blockIcon = this.otherMember.isblocked ? 'fas-user-lock' : 'fas-user-check';
            }
        } catch {
            // User cancelled.
        }
    }

    /**
     * Displays a confirmation modal to send a contact request to the other user of the individual conversation.
     *
     * @return Promise resolved when the request is sent or the dialog is cancelled.
     */
    async createContactRequest(): Promise<void> {
        if (!this.otherMember) {
            // Should never happen.
            throw new CoreError('No member selected to be requested.');
        }

        const template = Translate.instance.instant('addon.messages.addcontactconfirm', { $a: this.otherMember.fullname });
        const okText = Translate.instance.instant('core.add');

        try {
            await CoreDomUtils.instance.showConfirm(template, undefined, okText);

            this.addRemoveIcon = 'spinner';

            const modal = await CoreDomUtils.instance.showModalLoading('core.sending', true);
            this.showLoadingModal = true;

            try {
                try {
                    await AddonMessages.instance.createContactRequest(this.otherMember.id);
                } finally {
                    modal.dismiss();
                    this.showLoadingModal = false;
                }
            } catch (error) {
                CoreDomUtils.instance.showErrorModalDefault(error, 'core.error', true);
            } finally {
                this.addRemoveIcon = 'fas-user-plus';
            }
        } catch {
            // User cancelled.
        }
    }

    /**
     * Confirms the contact request of the other user of the individual conversation.
     *
     * @return Promise resolved when the request is confirmed.
     */
    async confirmContactRequest(): Promise<void> {
        if (!this.otherMember) {
            // Should never happen.
            throw new CoreError('No member selected to be confirmed.');
        }

        const modal = await CoreDomUtils.instance.showModalLoading('core.sending', true);
        this.showLoadingModal = true;

        try {
            try {
                await AddonMessages.instance.confirmContactRequest(this.otherMember.id);
            } finally {
                modal.dismiss();
                this.showLoadingModal = false;
            }
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'core.error', true);
        }
    }

    /**
     * Declines the contact request of the other user of the individual conversation.
     *
     * @return Promise resolved when the request is confirmed.
     */
    async declineContactRequest(): Promise<void> {
        if (!this.otherMember) {
            // Should never happen.
            throw new CoreError('No member selected to be declined.');
        }

        const modal = await CoreDomUtils.instance.showModalLoading('core.sending', true);
        this.showLoadingModal = true;

        try {
            try {
                await AddonMessages.instance.declineContactRequest(this.otherMember.id);
            } finally {
                modal.dismiss();
                this.showLoadingModal = false;
            }
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'core.error', true);
        }
    }

    /**
     * Displays a confirmation modal to remove the other user of the conversation from contacts.
     *
     * @return Promise resolved when the request is sent or the dialog is cancelled.
     */
    async removeContact(): Promise<void> {
        if (!this.otherMember) {
            // Should never happen.
            throw new CoreError('No member selected to be removed.');
        }

        const template = Translate.instance.instant('addon.messages.removecontactconfirm', { $a: this.otherMember.fullname });
        const okText = Translate.instance.instant('core.remove');

        try {
            await CoreDomUtils.instance.showConfirm(template, undefined, okText);

            this.addRemoveIcon = 'spinner';

            const modal = await CoreDomUtils.instance.showModalLoading('core.sending', true);
            this.showLoadingModal = true;

            try {
                try {
                    await AddonMessages.instance.removeContact(this.otherMember.id);
                } finally {
                    modal.dismiss();
                    this.showLoadingModal = false;
                }
            } catch (error) {
                CoreDomUtils.instance.showErrorModalDefault(error, 'core.error', true);
            } finally {
                this.addRemoveIcon = 'fas-user-plus';
            }
        } catch {
            // User cancelled.
        }

    }

    /**
     * Page destroyed.
     */
    ngOnDestroy(): void {
        // Unset again, just in case.
        this.unsetPolling();
        this.syncObserver?.off();
        this.keyboardObserver?.off();
        this.memberInfoObserver?.off();
        this.viewDestroyed = true;
    }

}
