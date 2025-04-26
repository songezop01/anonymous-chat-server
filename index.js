const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000,
    cors: {
        origin: ["http://localhost:3000", "https://anonymous-chat-server-d43x.onrender.com"],
        methods: ["GET", "POST"],
        credentials: true
    }
});
const port = process.env.PORT || 3000;

// 用於儲存用戶、好友和聊天數據
const users = new Map(); // uid -> {username, password, nickname, socket, deviceInfo, friends}
const chats = new Map(); // chatId -> {type: 'private', members: [uid1, uid2], name}
const groupChats = new Map(); // chatId -> {type: 'group', name, members: [uids]}

// 儲存聊天訊息歷史
const chatMessages = new Map(); // chatId -> [{fromUid, message, nickname, timestamp}]
const groupChatMessages = new Map(); // chatId -> [{fromUid, message, nickname, timestamp}]

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send('Anonymous Chat Server');
});

app.use((err, req, res, next) => {
    console.error('服務端錯誤:', err.stack);
    res.status(500).send('伺服器錯誤');
});

io.on('connection', (socket) => {
    console.log(`用戶已連接: ${socket.id}`);

    socket.on('error', (error) => {
        console.error(`Socket 錯誤: ${socket.id}, 錯誤: ${error.message}`);
    });

    socket.on('disconnect', (reason) => {
        console.log(`用戶已斷開: ${socket.id}, 原因: ${reason}`);
        for (let [uid, user] of users.entries()) {
            if (user.socket === socket) {
                users.delete(uid);
                break;
            }
        }
    });

    socket.on('register', (data) => {
        console.log('收到註冊請求:', data);
        try {
            const { username, password, nickname, deviceInfo } = data;

            let userExists = false;
            for (let user of users.values()) {
                if (user.username === username) {
                    userExists = true;
                    break;
                }
            }

            if (userExists) {
                socket.emit('registerResponse', { success: false, message: '用戶名已存在' });
                return;
            }

            const uid = generateUid();
            users.set(uid, {
                username,
                password,
                nickname: nickname || username,
                socket,
                deviceInfo: {
                    ipAddress: socket.handshake.address,
                    androidId: deviceInfo?.androidId || 'unknown',
                    model: deviceInfo?.model || 'unknown',
                    osVersion: deviceInfo?.osVersion || 'unknown'
                },
                friends: [] // 儲存好友列表 [{uid, nickname}]
            });

            socket.emit('registerResponse', { success: true, uid });
        } catch (error) {
            console.error('處理註冊失敗:', error);
            socket.emit('registerResponse', { success: false, message: '註冊失敗: ' + error.message });
        }
    });

    socket.on('login', (data) => {
        console.log('收到登入請求:', data);
        try {
            const { username, password, deviceInfo } = data;

            let foundUser = null;
            let uid = null;
            for (let [key, user] of users.entries()) {
                if (user.username === username && user.password === password) {
                    foundUser = user;
                    uid = key;
                    break;
                }
            }

            if (foundUser) {
                foundUser.socket = socket;
                foundUser.deviceInfo = {
                    ipAddress: socket.handshake.address,
                    androidId: deviceInfo?.androidId || 'unknown',
                    model: deviceInfo?.model || 'unknown',
                    osVersion: deviceInfo?.osVersion || 'unknown'
                };
                socket.emit('loginResponse', {
                    success: true,
                    uid,
                    username,
                    nickname: foundUser.nickname
                });
            } else {
                socket.emit('loginResponse', { success: false, message: '用戶名或密碼錯誤' });
            }
        } catch (error) {
            console.error('處理登入失敗:', error);
            socket.emit('loginResponse', { success: false, message: '登入失敗: ' + error.message });
        }
    });

    socket.on('updateNickname', (data) => {
        console.log('收到更新暱稱請求:', data);
        try {
            const { uid, nickname } = data;

            if (!users.has(uid)) {
                socket.emit('updateNicknameResponse', { success: false, message: '用戶不存在' });
                return;
            }

            const user = users.get(uid);
            user.nickname = nickname;

            // 更新好友列表中的暱稱
            for (let [otherUid, otherUser] of users.entries()) {
                otherUser.friends = otherUser.friends.map(friend =>
                    friend.uid === uid ? { uid, nickname } : friend
                );
            }

            socket.emit('updateNicknameResponse', { success: true, nickname });
        } catch (error) {
            console.error('處理更新暱稱失敗:', error);
            socket.emit('updateNicknameResponse', { success: false, message: '更新暱稱失敗: ' + error.message });
        }
    });

    socket.on('friendRequest', (data) => {
        console.log('收到好友請求:', data);
        try {
            const { fromUid, toUid } = data;

            if (!users.has(fromUid) || !users.has(toUid)) {
                socket.emit('friendRequestResponse', { success: false, message: '用戶不存在' });
                return;
            }

            const fromUser = users.get(fromUid);
            const toUser = users.get(toUid);

            if (fromUser.friends.some(f => f.uid === toUid)) {
                socket.emit('friendRequestResponse', { success: false, message: '已是好友' });
                return;
            }

            toUser.socket.emit('friendRequest', {
                fromUid,
                fromNickname: fromUser.nickname
            });
            socket.emit('friendRequestResponse', { success: true });
        } catch (error) {
            console.error('處理好友請求失敗:', error);
            socket.emit('friendRequestResponse', { success: false, message: '發送好友請求失敗: ' + error.message });
        }
    });

    socket.on('acceptFriendRequest', (data) => {
        console.log('收到接受好友請求:', data);
        try {
            const { fromUid, toUid } = data;

            if (!users.has(fromUid) || !users.has(toUid)) {
                socket.emit('friendRequestFailed', { message: '用戶不存在' });
                return;
            }

            const fromUser = users.get(fromUid);
            const toUser = users.get(toUid);

            fromUser.friends.push({ uid: toUid, nickname: toUser.nickname });
            toUser.friends.push({ uid: fromUid, nickname: fromUser.nickname });

            const chatId = generateUid();
            chats.set(chatId, {
                type: 'private',
                members: [fromUid, toUid],
                name: `${fromUser.nickname} & ${toUser.nickname}`
            });
            chatMessages.set(chatId, []);

            fromUser.socket.emit('friendRequestAccepted', {
                fromUid: toUid,
                fromNickname: toUser.nickname,
                chatId
            });
            toUser.socket.emit('friendRequestAccepted', {
                fromUid,
                fromNickname: fromUser.nickname,
                chatId
            });
        } catch (error) {
            console.error('處理接受好友請求失敗:', error);
            socket.emit('friendRequestFailed', { message: '接受好友請求失敗: ' + error.message });
        }
    });

    socket.on('rejectFriendRequest', (data) => {
        console.log('收到拒絕好友請求:', data);
        try {
            const { fromUid, toUid } = data;

            if (!users.has(fromUid)) {
                return;
            }

            const fromUser = users.get(fromUid);
            fromUser.socket.emit('friendRequestRejected', { fromUid: toUid });
        } catch (error) {
            console.error('處理拒絕好友請求失敗:', error);
            socket.emit('friendRequestFailed', { message: '拒絕好友請求失敗: ' + error.message });
        }
    });

    socket.on('startFriendChat', (data) => {
        console.log('收到開始好友聊天請求:', data);
        try {
            const { fromUid, toUid } = data;

            if (!users.has(fromUid) || !users.has(toUid)) {
                socket.emit('startFriendChatResponse', { success: false, message: '用戶不存在' });
                return;
            }

            let chatId = null;
            for (let [id, chat] of chats.entries()) {
                if (chat.type === 'private' && chat.members.includes(fromUid) && chat.members.includes(toUid)) {
                    chatId = id;
                    break;
                }
            }

            if (!chatId) {
                socket.emit('startFriendChatResponse', { success: false, message: '聊天不存在' });
                return;
            }

            socket.emit('startFriendChatResponse', { success: true, chatId });
        } catch (error) {
            console.error('處理開始好友聊天失敗:', error);
            socket.emit('startFriendChatResponse', { success: false, message: '開始聊天失敗: ' + error.message });
        }
    });

    socket.on('chatMessage', (data) => {
        console.log('收到聊天訊息:', data);
        try {
            const { chatId, fromUid, message } = data;

            if (!chats.has(chatId)) {
                socket.emit('chatMessageFailed', { message: '聊天室不存在' });
                return;
            }

            const chat = chats.get(chatId);
            const fromUser = users.get(fromUid);
            const timestamp = Date.now();
            const messageData = {
                chatId,
                fromUid,
                message,
                nickname: fromUser.nickname,
                timestamp
            };

            if (!chatMessages.has(chatId)) {
                chatMessages.set(chatId, []);
            }
            chatMessages.get(chatId).push(messageData);

            chat.members.forEach(userId => {
                if (users.has(userId) && userId !== fromUid) {
                    const user = users.get(userId);
                    user.socket.emit('chatMessage', messageData);
                }
            });
        } catch (error) {
            console.error('處理聊天訊息失敗:', error);
            socket.emit('chatMessageFailed', { message: '發送訊息失敗: ' + error.message });
        }
    });

    socket.on('createGroupChat', (data) => {
        console.log('收到創建群聊請求:', data);
        try {
            const { groupName, memberUids } = data;

            const validMembers = memberUids.filter(uid => users.has(uid));
            if (validMembers.length === 0) {
                socket.emit('createGroupChatResponse', { success: false, message: '無效的成員列表' });
                return;
            }

            const chatId = generateUid();
            groupChats.set(chatId, {
                type: 'group',
                name: groupName,
                members: validMembers
            });
            groupChatMessages.set(chatId, []);

            validMembers.forEach(uid => {
                const user = users.get(uid);
                user.socket.emit('groupChatCreated', { chatId, name: groupName });
            });

            socket.emit('createGroupChatResponse', { success: true, chatId });
        } catch (error) {
            console.error('處理創建群聊失敗:', error);
            socket.emit('createGroupChatResponse', { success: false, message: '創建群聊失敗: ' + error.message });
        }
    });

    socket.on('groupMessage', (data) => {
        console.log('收到群組訊息:', data);
        try {
            const { chatId, fromUid, message } = data;

            if (!groupChats.has(chatId)) {
                socket.emit('groupMessageFailed', { message: '群聊不存在' });
                return;
            }

            const groupChat = groupChats.get(chatId);
            const fromUser = users.get(fromUid);
            const timestamp = Date.now();
            const messageData = {
                chatId,
                fromUid,
                message,
                nickname: fromUser.nickname,
                timestamp
            };

            if (!groupChatMessages.has(chatId)) {
                groupChatMessages.set(chatId, []);
            }
            groupChatMessages.get(chatId).push(messageData);

            groupChat.members.forEach(userId => {
                if (users.has(userId) && userId !== fromUid) {
                    const user = users.get(userId);
                    user.socket.emit('groupMessage', messageData);
                }
            });
        } catch (error) {
            console.error('處理群組訊息失敗:', error);
            socket.emit('groupMessageFailed', { message: '發送群組訊息失敗: ' + error.message });
        }
    });

    socket.on('getChatList', (data) => {
        console.log('收到獲取聊天列表請求:', data);
        try {
            const { uid } = data;
            if (!users.has(uid)) {
                socket.emit('getChatListResponse', { success: false, message: '用戶不存在' });
                return;
            }

            const chatList = [];
            for (let [chatId, chat] of chats.entries()) {
                if (chat.members.includes(uid)) {
                    const messages = chatMessages.get(chatId) || [];
                    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                    const otherUserId = chat.members.find(userId => userId !== uid);
                    const otherUser = users.get(otherUserId);
                    chatList.push({
                        chatId,
                        type: 'private',
                        name: otherUser ? otherUser.nickname : otherUserId,
                        lastMessage
                    });
                }
            }

            for (let [chatId, groupChat] of groupChats.entries()) {
                if (groupChat.members.includes(uid)) {
                    const messages = groupChatMessages.get(chatId) || [];
                    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                    chatList.push({
                        chatId,
                        type: 'group',
                        name: groupChat.name,
                        lastMessage
                    });
                }
            }

            socket.emit('getChatListResponse', { success: true, chatList });
        } catch (error) {
            console.error('處理獲取聊天列表失敗:', error);
            socket.emit('getChatListResponse', { success: false, message: '獲取聊天列表失敗: ' + error.message });
        }
    });

    socket.on('getFriendList', (data) => {
        console.log('收到獲取好友列表請求:', data);
        try {
            const { uid } = data;
            if (!users.has(uid)) {
                socket.emit('getFriendListResponse', { success: false, message: '用戶不存在' });
                return;
            }

            const user = users.get(uid);
            socket.emit('getFriendListResponse', { success: true, friends: user.friends });
        } catch (error) {
            console.error('處理獲取好友列表失敗:', error);
            socket.emit('getFriendListResponse', { success: false, message: '獲取好友列表失敗: ' + error.message });
        }
    });

    socket.on('getChatHistory', (data) => {
        console.log('收到獲取聊天歷史請求:', data);
        try {
            const { chatId } = data;
            let messages = [];

            if (chats.has(chatId)) {
                messages = chatMessages.get(chatId) || [];
            } else if (groupChats.has(chatId)) {
                messages = groupChatMessages.get(chatId) || [];
            } else {
                socket.emit('getChatHistoryResponse', { success: false, message: '聊天不存在' });
                return;
            }

            socket.emit('getChatHistoryResponse', { success: true, messages });
        } catch (error) {
            console.error('處理獲取聊天歷史失敗:', error);
            socket.emit('getChatHistoryResponse', { success: false, message: '獲取聊天歷史失敗: ' + error.message });
        }
    });
});

function generateUid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

http.listen(port, () => {
    console.log(`服務器運行在端口 ${port}`);
});
