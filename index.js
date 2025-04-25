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

// 用於儲存用戶和聊天數據
const users = new Map();
const chats = new Map();
const groupChats = new Map();

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
            const username = data.username;
            const password = data.password;

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
                username: username,
                password: password,
                socket: socket,
                nickname: username
            });

            socket.emit('registerResponse', { success: true, uid: uid });
        } catch (error) {
            console.error('處理註冊失敗:', error);
            socket.emit('registerResponse', { success: false, message: '註冊失敗: ' + error.message });
        }
    });

    socket.on('login', (data) => {
        console.log('收到登入請求:', data);
        try {
            const username = data.username;
            const password = data.password;

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
                socket.emit('loginResponse', { success: true, uid: uid });
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
            const uid = data.uid;
            const nickname = data.nickname;

            if (!users.has(uid)) {
                socket.emit('updateNicknameResponse', { success: false, message: '用戶不存在' });
                return;
            }

            const user = users.get(uid);
            user.nickname = nickname;
            socket.emit('updateNicknameResponse', { success: true, nickname: nickname });
        } catch (error) {
            console.error('處理更新暱稱失敗:', error);
            socket.emit('updateNicknameResponse', { success: false, message: '更新暱稱失敗: ' + error.message });
        }
    });

    socket.on('chatRequest', (data) => {
        console.log('收到聊天請求:', data);
        try {
            const fromUid = data.fromUid;
            const toUid = data.toUid;

            if (!users.has(fromUid) || !users.has(toUid)) {
                socket.emit('chatRequestFailed', { message: '用戶不存在' });
                return;
            }

            const chatId = generateUid();
            chats.set(chatId, { users: [fromUid, toUid] });
            chatMessages.set(chatId, []); // 初始化訊息歷史

            const fromUser = users.get(fromUid);
            const toUser = users.get(toUid);
            toUser.socket.emit('chatRequest', { chatId: chatId, fromUid: fromUid, toUid: toUid });
            fromUser.socket.emit('chatRequestResponse', { success: true, message: '聊天請求已發送' });
        } catch (error) {
            console.error('處理聊天請求失敗:', error);
            socket.emit('chatRequestFailed', { message: '聊天請求失敗: ' + error.message });
        }
    });

    socket.on('acceptChatRequest', (data) => {
        console.log('收到接受聊天請求:', data);
        try {
            const chatId = data.chatId;
            const fromUid = data.fromUid;
            const toUid = data.toUid;

            if (!chats.has(chatId)) {
                socket.emit('chatRequestFailed', { message: '聊天室不存在' });
                return;
            }

            const fromUser = users.get(fromUid);
            const toUser = users.get(toUid);
            fromUser.socket.emit('chatRequestAccepted', { chatId: chatId, fromUid: fromUid, toUid: toUid });
            toUser.socket.emit('chatRequestAccepted', { chatId: chatId, fromUid: fromUid, toUid: toUid });
        } catch (error) {
            console.error('處理接受聊天請求失敗:', error);
            socket.emit('chatRequestFailed', { message: '接受聊天請求失敗: ' + error.message });
        }
    });

    socket.on('chatMessage', (data) => {
        console.log('收到聊天訊息:', data);
        try {
            const chatId = data.chatId;
            const fromUid = data.fromUid;
            const message = data.message;

            if (!chats.has(chatId)) {
                socket.emit('chatMessageFailed', { message: '聊天室不存在' });
                return;
            }

            const chat = chats.get(chatId);
            const timestamp = Date.now();
            const fromUser = users.get(fromUid);
            const messageData = {
                chatId: chatId,
                fromUid: fromUid,
                message: message,
                nickname: fromUser.nickname,
                timestamp: timestamp
            };

            // 儲存訊息到歷史
            if (!chatMessages.has(chatId)) {
                chatMessages.set(chatId, []);
            }
            chatMessages.get(chatId).push(messageData);

            chat.users.forEach(userId => {
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
            const groupName = data.groupName;
            const memberUids = data.memberUids;

            const validMembers = memberUids.filter(uid => users.has(uid));
            if (validMembers.length === 0) {
                socket.emit('createGroupChatResponse', { success: false, message: '無效的成員列表' });
                return;
            }

            const chatId = generateUid();
            groupChats.set(chatId, {
                name: groupName,
                members: validMembers
            });
            groupChatMessages.set(chatId, []); // 初始化訊息歷史

            validMembers.forEach(uid => {
                const user = users.get(uid);
                user.socket.emit('groupChatCreated', { chatId: chatId, name: groupName });
            });

            socket.emit('createGroupChatResponse', { success: true, chatId: chatId });
        } catch (error) {
            console.error('處理創建群聊失敗:', error);
            socket.emit('createGroupChatResponse', { success: false, message: '創建群聊失敗: ' + error.message });
        }
    });

    socket.on('groupMessage', (data) => {
        console.log('收到群組訊息:', data);
        try {
            const chatId = data.chatId;
            const fromUid = data.fromUid;
            const message = data.message;

            if (!groupChats.has(chatId)) {
                socket.emit('groupMessageFailed', { message: '群聊不存在' });
                return;
            }

            const groupChat = groupChats.get(chatId);
            const timestamp = Date.now();
            const fromUser = users.get(fromUid);
            const messageData = {
                chatId: chatId,
                fromUid: fromUid,
                message: message,
                nickname: fromUser.nickname,
                timestamp: timestamp
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
            const uid = data.uid;
            if (!users.has(uid)) {
                socket.emit('getChatListResponse', { success: false, message: '用戶不存在' });
                return;
            }

            const chatList = [];
            for (let [chatId, chat] of chats.entries()) {
                if (chat.users.includes(uid)) {
                    const messages = chatMessages.get(chatId) || [];
                    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                    const otherUserId = chat.users.find(userId => userId !== uid);
                    const otherUser = users.get(otherUserId);
                    chatList.push({
                        chatId: chatId,
                        type: 'private',
                        name: otherUser ? otherUser.nickname : otherUserId,
                        lastMessage: lastMessage
                    });
                }
            }

            for (let [chatId, groupChat] of groupChats.entries()) {
                if (groupChat.members.includes(uid)) {
                    const messages = groupChatMessages.get(chatId) || [];
                    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                    chatList.push({
                        chatId: chatId,
                        type: 'group',
                        name: groupChat.name,
                        lastMessage: lastMessage
                    });
                }
            }

            socket.emit('getChatListResponse', { success: true, chatList: chatList });
        } catch (error) {
            console.error('處理獲取聊天列表失敗:', error);
            socket.emit('getChatListResponse', { success: false, message: '獲取聊天列表失敗: ' + error.message });
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
