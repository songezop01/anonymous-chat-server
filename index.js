const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000, // 等待 PONG 的時間，設為 60 秒
    pingInterval: 25000 // 發送 PING 的間隔，設為 25 秒
});
const port = process.env.PORT || 3000;

// 用於儲存用戶和聊天數據
const users = new Map(); // 儲存 UID 對應的 socket 和用戶信息
const chats = new Map(); // 儲存聊天室信息
const groupChats = new Map(); // 儲存群聊信息

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send('Anonymous Chat Server');
});

io.on('connection', (socket) => {
    console.log(`用戶已連接: ${socket.id}`);

    socket.on('disconnect', (reason) => {
        console.log(`用戶已斷開: ${socket.id}, 原因: ${reason}`);
        // 清理用戶數據
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

            // 檢查用戶名是否已存在
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

            // 生成唯一的 UID
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
                foundUser.socket = socket; // 更新 socket
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

            const fromUser = users.get(fromUid);
            const toUser = users.get(toUid);
            toUser.socket.emit('chatRequest', { chatId: chatId, fromUid: fromUid, toUid: toUid });
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

            chat.users.forEach(userId => {
                if (users.has(userId)) {
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
            const memberUids = data.memberUids; // 期望為一個數組

            // 驗證成員
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

            groupChat.members.forEach(userId => {
                if (users.has(userId)) {
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
            // 獲取一對一聊天
            for (let [chatId, chat] of chats.entries()) {
                if (chat.users.includes(uid)) {
                    chatList.push({
                        chatId: chatId,
                        type: 'private',
                        name: chat.users.find(userId => userId !== uid),
                        lastMessage: null // 可以在此處添加最近消息邏輯
                    });
                }
            }

            // 獲取群聊
            for (let [chatId, groupChat] of groupChats.entries()) {
                if (groupChat.members.includes(uid)) {
                    chatList.push({
                        chatId: chatId,
                        type: 'group',
                        name: groupChat.name,
                        lastMessage: null // 可以在此處添加最近消息邏輯
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
