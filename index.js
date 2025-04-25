const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['polling', 'websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
});

const users = new Map();

app.get('/', (req, res) => {
    res.send('Anonymous Chat Server is running');
});

io.on('connection', (socket) => {
    console.log(`用戶已連接: ${socket.id}`);

    socket.on('keepAlive', (data) => {
        console.log(`收到心跳: ${data}`);
        socket.emit('keepAliveResponse', 'pong');
    });

    socket.on('register', (data) => {
        console.log(`收到註冊請求: ${JSON.stringify(data)}`);
        const { username, password, macAddress } = data;
        const uid = uuidv4();
        users.set(uid, { username, password, macAddress, socketId: socket.id });
        socket.emit('registerResponse', { success: true, uid });
        console.log(`用戶註冊成功，UID: ${uid}, 用戶名: ${username}, MAC: ${macAddress}`);
    });

    socket.on('login', (data) => {
        console.log(`收到登入請求: ${JSON.stringify(data)}`);
        const { username, password } = data;
        for (const [uid, user] of users.entries()) {
            if (user.username === username && user.password === password) {
                user.socketId = socket.id; // 更新 socketId
                socket.emit('loginResponse', { success: true, uid });
                console.log(`用戶登入成功，UID: ${uid}, 用戶名: ${username}, MAC: ${user.macAddress}`);
                return;
            }
        }
        socket.emit('loginResponse', { success: false, message: '用戶名或密碼錯誤' });
        console.log(`用戶登入失敗: ${username}`);
    });

    socket.on('chatRequest', (data, callback) => {
        console.log(`收到聊天請求: ${JSON.stringify(data)}`);
        const { fromUid, toUid } = data;
        const targetUser = users.get(toUid);
        const response = targetUser && targetUser.socketId
            ? { success: true }
            : { success: false, message: '目標用戶不存在或不在线' };

        if (response.success) {
            io.to(targetUser.socketId).emit('chatRequest', { fromUid, toUid });
            console.log(`已將聊天請求發送給 UID: ${toUid}, Socket ID: ${targetUser.socketId}`);
        } else {
            console.log(`無法發送聊天請求，目標用戶不在线: ${toUid}`);
        }

        if (typeof callback === 'function') {
            callback(response);
        } else {
            console.warn('chatRequest 事件未收到有效的回調函數，將直接發送 chatRequestResponse 事件');
            socket.emit('chatRequestResponse', response);
        }
    });

    socket.on('chatAccepted', (data) => {
        console.log(`聊天請求被接受: ${JSON.stringify(data)}`);
        const { fromUid, toUid } = data;
        const fromUser = users.get(fromUid);
        if (fromUser && fromUser.socketId) {
            io.to(fromUser.socketId).emit('chatAccepted', { toUid });
            console.log(`已通知 UID: ${fromUid} 聊天請求被接受`);
        } else {
            console.log(`無法通知 UID: ${fromUid}，用戶不在线`);
        }
    });

    socket.on('chatRejected', (data) => {
        console.log(`聊天請求被拒絕: ${JSON.stringify(data)}`);
        const { fromUid, toUid } = data;
        const fromUser = users.get(fromUid);
        if (fromUser && fromUser.socketId) {
            io.to(fromUser.socketId).emit('chatRejected', { toUid });
            console.log(`已通知 UID: ${fromUid} 聊天請求被拒絕`);
        } else {
            console.log(`無法通知 UID: ${fromUid}，用戶不在线`);
        }
    });

    socket.on('chatMessage', (data) => {
        console.log(`收到聊天訊息: ${JSON.stringify(data)}`);
        const { fromUid, toUid, message } = data;
        const targetUser = users.get(toUid);
        if (targetUser && targetUser.socketId) {
            io.to(targetUser.socketId).emit('chatMessage', { fromUid, message });
            console.log(`已將訊息發送給 UID: ${toUid}, Socket ID: ${targetUser.socketId}`);
        } else {
            console.log(`無法發送訊息，目標用戶不在线: ${toUid}`);
        }
    });

    socket.on('groupMessage', (data) => {
        console.log(`收到群組訊息: ${JSON.stringify(data)}`);
        const { fromUid, groupId, message } = data;
        io.emit('groupMessage', { fromUid, groupId, message });
    });

    socket.on('disconnect', () => {
        console.log(`用戶已斷開: ${socket.id}`);
        for (const [uid, user] of users.entries()) {
            if (user.socketId === socket.id) {
                user.socketId = null;
                console.log(`用戶 ${uid} 已離線`);
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服務器運行在端口 ${PORT}`);
});
