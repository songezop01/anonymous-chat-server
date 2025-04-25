const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['polling', 'websocket'],
    pingTimeout: 120000,
    pingInterval: 60000
});

app.get('/', (req, res) => {
    res.send('Anonymous Chat Server is running');
});

app.get('/socket.io/*', (req, res, next) => {
    console.log('收到輪詢請求:', req.url);
    next();
});

app.post('/socket.io/*', (req, res, next) => {
    console.log('收到輪詢 POST 請求:', req.url);
    next();
});

app.use(express.static(__dirname));

const users = [];
const messages = [];
const chatRequests = [];
const groups = [];

io.on('connection', (socket) => {
    console.log('用戶已連接:', socket.id);
    console.log('協議版本:', socket.conn.protocol ?? '未知');
    console.log('傳輸協議:', socket.conn.transport.name);
    console.log('當前時間:', new Date().toISOString()); // 添加時間戳記
});
    socket.on('error', (error) => {
        console.log('Socket.IO 客戶端錯誤:', error);
    });

    socket.on('connect_error', (error) => {
        console.log('Socket.IO 連線錯誤:', error);
    });

    socket.on('keepAlive', (data) => {
        console.log('收到心跳:', data);
        socket.emit('keepAliveResponse', 'pong');
    });

    socket.on('register', (data) => {
        console.log('收到註冊請求:', data);
        const { username, password, macAddress } = data;
        if (users.find(u => u.username === username)) {
            socket.emit('registerResponse', { success: false, message: '用戶名已存在' });
            return;
        }
        if (users.find(u => u.macAddress === macAddress)) {
            socket.emit('registerResponse', { success: false, message: '此設備已註冊' });
            return;
        }
        const uid = uuidv4();
        const user = { username, password, uid, macAddress, socketId: socket.id };
        users.push(user);
        socket.emit('registerResponse', { success: true, uid });
        console.log('用戶註冊成功:', user);
    });

    socket.on('login', (data) => {
        console.log('收到登入請求:', data);
        const { username, password } = data;
        const user = users.find(u => u.username === username && u.password === password);
        if (user) {
            user.socketId = socket.id;
            socket.emit('loginResponse', { success: true, uid: user.uid });
        } else {
            socket.emit('loginResponse', { success: false, message: '用戶名或密碼錯誤' });
        }
    });

    socket.on('chatRequest', (data, callback) => {
        const { fromUid, toUid } = data;
        const toUser = users.find(u => u.uid === toUid);
        if (!toUser) {
            callback({ success: false, message: '對方 UID 不存在' });
            return;
        }
        chatRequests.push({ fromUid, toUid });
        io.to(toUser.socketId).emit('chatRequest', { fromUid });
        callback({ success: true });
    });

    socket.on('chatResponse', (data) => {
        const { fromUid, toUid, accepted } = data;
        const request = chatRequests.find(r => r.fromUid === fromUid && r.toUid === toUid);
        if (!request) return;
        chatRequests.splice(chatRequests.indexOf(request), 1);
        const fromUser = users.find(u => u.uid === fromUid);
        if (accepted) {
            io.to(fromUser.socketId).emit('chatAccepted', { toUid });
        } else {
            io.to(fromUser.socketId).emit('chatRejected', { toUid });
        }
    });

    socket.on('chatMessage', (data) => {
        const { fromUid, toUid, content, timestamp } = data;
        const toUser = users.find(u => u.uid === toUid);
        if (!toUser) return;
        const message = { fromUid, toUid, content, timestamp };
        messages.push(message);
        io.to(toUser.socketId).emit('chatMessage', message);
        console.log('一對一訊息:', message);
    });

    socket.on('createGroup', (data, callback) => {
        const { groupName, creatorUid } = data;
        const groupId = uuidv4();
        const group = { groupId, name: groupName, members: [creatorUid] };
        groups.push(group);
        callback({ success: true, groupId });
        console.log('群組創建:', group);
    });

    socket.on('joinGroup', (data, callback) => {
        const { groupId, uid } = data;
        const group = groups.find(g => g.groupId === groupId);
        if (!group) {
            callback({ success: false, message: '群組不存在' });
            return;
        }
        if (!group.members.includes(uid)) {
            group.members.push(uid);
        }
        callback({ success: true });
    });

    socket.on('groupMessage', (data) => {
        const { groupId, fromUid, content, timestamp } = data;
        const group = groups.find(g => g.groupId === groupId);
        if (!group) return;
        const message = { groupId, fromUid, content, timestamp };
        group.members.forEach(uid => {
            const user = users.find(u => u.uid === uid);
            if (user && user.socketId !== socket.id) {
                io.to(user.socketId).emit('groupMessage', message);
            }
        });
        console.log('群組訊息:', message);
    });

    socket.on('disconnect', () => {
        console.log('用戶斷開:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服務器運行在端口 ${PORT}`);
});
