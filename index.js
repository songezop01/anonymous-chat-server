const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 用戶數據（模擬數據庫）
const users = new Map(); // 存儲用戶信息 { uid: { username, password, macAddress, socketId, nickname } }
const onlineUsers = new Map(); // 存儲在線用戶 { socketId: uid }

// 聊天數據
const chats = new Map(); // 存儲聊天信息 { chatId: { type: 'private'|'group', members: [uid], messages: [{ fromUid, message, timestamp }], name: string (群聊名稱) } }
const userChats = new Map(); // 存儲用戶的聊天列表 { uid: [chatId] }

// 處理連接
io.on('connection', (socket) => {
    console.log('用戶已連接:', socket.id);

    // 心跳檢測
    socket.on('ping', () => {
        console.log('收到心跳: ping');
        socket.emit('pong');
    });

    // 註冊
    socket.on('register', (data, callback) => {
        console.log('收到註冊請求:', data);
        const { username, password, macAddress } = data;
        const uid = uuidv4();
        users.set(uid, { username, password, macAddress, socketId: socket.id, nickname: username });
        onlineUsers.set(socket.id, uid);
        userChats.set(uid, []);
        console.log('用戶註冊成功，UID:', uid, ', 用戶名:', username, ', MAC:', macAddress);
        callback({ success: true, uid, username });
    });

    // 登入
    socket.on('login', (data, callback) => {
        console.log('收到登入請求:', data);
        const { username, password } = data;
        let foundUser = null;
        for (const [uid, user] of users.entries()) {
            if (user.username === username && user.password === password) {
                foundUser = { uid, ...user };
                break;
            }
        }
        if (foundUser) {
            foundUser.socketId = socket.id;
            users.set(foundUser.uid, foundUser);
            onlineUsers.set(socket.id, foundUser.uid);
            console.log('用戶登入成功，UID:', foundUser.uid, ', 用戶名:', username, ', MAC:', foundUser.macAddress);
            // 返回用戶的聊天列表
            const userChatIds = userChats.get(foundUser.uid) || [];
            const userChatList = userChatIds.map(chatId => {
                const chat = chats.get(chatId);
                return {
                    chatId,
                    type: chat.type,
                    name: chat.name || (chat.type === 'private' ? getChatPartnerName(foundUser.uid, chat.members) : chat.name),
                    members: chat.members,
                    lastMessage: chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : null
                };
            });
            callback({ success: true, uid: foundUser.uid, username, nickname: foundUser.nickname, chatList: userChatList });
        } else {
            callback({ success: false, message: '用戶名或密碼錯誤' });
        }
    });

    // 更新暱稱
    socket.on('updateNickname', (data, callback) => {
        const uid = onlineUsers.get(socket.id);
        if (uid) {
            const user = users.get(uid);
            user.nickname = data.nickname;
            users.set(uid, user);
            callback({ success: true, nickname: user.nickname });
        } else {
            callback({ success: false, message: '用戶未登入' });
        }
    });

    // 發送聊天請求（一對一）
    socket.on('chatRequest', (data, callback) => {
        console.log('收到聊天請求:', data);
        const { fromUid, toUid } = data;
        const toSocketId = getSocketIdByUid(toUid);
        if (toSocketId) {
            // 檢查是否已有聊天
            let chatId = findExistingPrivateChat(fromUid, toUid);
            if (!chatId) {
                chatId = uuidv4();
                chats.set(chatId, { type: 'private', members: [fromUid, toUid], messages: [] });
                userChats.get(fromUid).push(chatId);
                userChats.get(toUid).push(chatId);
            }
            io.to(toSocketId).emit('chatRequest', { chatId, fromUid, toUid });
            console.log('已將聊天請求發送給 UID:', toUid, ', Socket ID:', toSocketId);
            if (typeof callback === 'function') {
                callback({ success: true });
            } else {
                console.log('chatRequest 事件未收到有效的回調函數，將直接發送 chatRequestResponse 事件');
                io.to(toSocketId).emit('chatRequestResponse', { success: true });
            }
        } else {
            if (typeof callback === 'function') {
                callback({ success: false, message: '用戶不在线' });
            }
        }
    });

    // 接受聊天請求
    socket.on('acceptChatRequest', (data) => {
        console.log('聊天請求被接受:', data);
        const { chatId, fromUid, toUid } = data;
        const fromSocketId = getSocketIdByUid(fromUid);
        const toSocketId = getSocketIdByUid(toUid);
        if (fromSocketId && toSocketId) {
            io.to(fromSocketId).emit('chatRequestAccepted', { chatId, fromUid, toUid });
            io.to(toSocketId).emit('chatRequestAccepted', { chatId, fromUid, toUid });
            console.log('已通知 UID:', fromUid, '聊天請求被接受');
        }
    });

    // 創建群聊
    socket.on('createGroupChat', (data, callback) => {
        const { groupName, memberUids } = data;
        const creatorUid = onlineUsers.get(socket.id);
        if (!creatorUid) {
            callback({ success: false, message: '用戶未登入' });
            return;
        }
        const chatId = uuidv4();
        const members = [creatorUid, ...memberUids];
        chats.set(chatId, { type: 'group', name: groupName, members, messages: [] });
        members.forEach(uid => {
            if (!userChats.get(uid)) userChats.set(uid, []);
            userChats.get(uid).push(chatId);
            const socketId = getSocketIdByUid(uid);
            if (socketId) {
                io.to(socketId).emit('groupChatCreated', { chatId, name: groupName, members });
            }
        });
        callback({ success: true, chatId, name: groupName, members });
    });

    // 發送消息（支持一對一和群聊）
    socket.on('sendMessage', (data) => {
        console.log('收到聊天訊息:', data);
        const { chatId, fromUid, message } = data;
        const chat = chats.get(chatId);
        if (chat) {
            const messageData = { fromUid, message, timestamp: Date.now(), nickname: users.get(fromUid)?.nickname || users.get(fromUid)?.username };
            chat.messages.push(messageData);
            chat.members.forEach(memberUid => {
                if (memberUid !== fromUid) {
                    const socketId = getSocketIdByUid(memberUid);
                    if (socketId) {
                        io.to(socketId).emit('receiveMessage', { chatId, ...messageData });
                        console.log('已將訊息發送給 UID:', memberUid, ', Socket ID:', socketId);
                    }
                }
            });
        }
    });

    // 斷開連接
    socket.on('disconnect', () => {
        const uid = onlineUsers.get(socket.id);
        if (uid) {
            onlineUsers.delete(socket.id);
            console.log('用戶', uid, '已離線');
        }
        console.log('用戶已斷開:', socket.id);
    });
});

// 輔助函數：根據 UID 查找 Socket ID
function getSocketIdByUid(uid) {
    for (const [socketId, userUid] of onlineUsers.entries()) {
        if (userUid === uid) return socketId;
    }
    return null;
}

// 輔助函數：查找現有的一對一聊天
function findExistingPrivateChat(uid1, uid2) {
    const userChatIds = userChats.get(uid1) || [];
    for (const chatId of userChatIds) {
        const chat = chats.get(chatId);
        if (chat.type === 'private' && chat.members.includes(uid1) && chat.members.includes(uid2)) {
            return chatId;
        }
    }
    return null;
}

// 輔助函數：獲取一對一聊天的對方名稱
function getChatPartnerName(currentUid, members) {
    const partnerUid = members.find(uid => uid !== currentUid);
    const partner = users.get(partnerUid);
    return partner ? (partner.nickname || partner.username) : '未知用戶';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服務器運行在端口 ${PORT}`);
});
