const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000,
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    maxHttpBufferSize: 1e7,
    perMessageDeflate: false
});
const { MongoClient } = require('mongodb');
const port = process.env.PORT || 10000;

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
});
let db;

async function connectToMongo() {
    let retries = 5;
    while (retries > 0) {
        try {
            await client.connect();
            console.log("Connected to MongoDB");
            db = client.db("anonymousChat");
            await db.createCollection("users");
            await db.createCollection("chats");
            await db.createCollection("groupChats");
            await db.createCollection("chatMessages");
            await db.createCollection("groupChatMessages");
            await db.createCollection("pendingRequests");
            return;
        } catch (error) {
            console.error(`MongoDB 連接失敗 (第 ${6 - retries}/5 次):`, error);
            retries--;
            if (retries === 0) process.exit(1);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

connectToMongo().then(() => {
    http.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}).catch(err => {
    console.error("伺服器啟動失敗:", err);
    process.exit(1);
});

app.use(express.static('public'));
app.get('/', (req, res) => res.send('Anonymous Chat Server'));

io.on('connection', (socket) => {
    console.log(`用戶連接: ${socket.id}`);

    socket.on('disconnect', () => {
        db.collection('users').updateOne(
            { socketId: socket.id },
            { $set: { online: false, socketId: null } }
        );
    });

    socket.on('register', async (data) => {
        try {
            const { username, password, nickname, deviceInfo } = data;
            const existingUser = await db.collection('users').findOne({ username });
            if (existingUser) {
                socket.emit('registerResponse', { success: false, message: '用戶名已存在' });
                return;
            }
            const uid = generateUid();
            await db.collection('users').insertOne({
                uid, username, password, nickname: nickname || username,
                socketId: socket.id, online: true, deviceInfo, friends: []
            });
            socket.emit('registerResponse', { success: true, uid });
        } catch (error) {
            socket.emit('registerResponse', { success: false, message: '註冊失敗: ' + error.message });
        }
    });

    socket.on('login', async (data) => {
        try {
            const { username, password, deviceInfo } = data;
            const user = await db.collection('users').findOne({ username, password });
            if (user) {
                await db.collection('users').updateOne(
                    { uid: user.uid },
                    { $set: { socketId: socket.id, online: true, deviceInfo } }
                );
                socket.emit('loginResponse', {
                    success: true, uid: user.uid, username, nickname: user.nickname || username
                });
            } else {
                socket.emit('loginResponse', { success: false, message: '用戶名或密碼錯誤' });
            }
        } catch (error) {
            socket.emit('loginResponse', { success: false, message: '登入失敗: ' + error.message });
        }
    });

    socket.on('createGroupChat', async (data) => {
        try {
            const { groupName, password, memberUids, creatorUid } = data;
            if (!Array.isArray(memberUids) || memberUids.length === 0) {
                socket.emit('createGroupChatResponse', { success: false, message: '無效的成員列表' });
                return;
            }
            const creator = await db.collection('users').findOne({ uid: creatorUid });
            if (!creator) {
                socket.emit('createGroupChatResponse', { success: false, message: '創建者不存在' });
                return;
            }
            const validMembers = [];
            for (const uid of memberUids) {
                const user = await db.collection('users').findOne({ uid });
                if (user) validMembers.push(uid);
            }
            if (validMembers.length === 0) {
                socket.emit('createGroupChatResponse', { success: false, message: '無有效成員' });
                return;
            }
            if (!validMembers.includes(creatorUid)) validMembers.push(creatorUid);

            const chatId = generateUid();
            const groupId = generateUid();
            await db.collection('groupChats').insertOne({
                chatId, groupId, type: 'group', name: groupName, password,
                adminUid: creatorUid, members: validMembers
            });
            await db.collection('groupChatMessages').insertOne({ chatId, messages: [] });

            for (const uid of validMembers) {
                const user = await db.collection('users').findOne({ uid });
                if (user.online && user.socketId) {
                    io.to(user.socketId).emit('groupChatCreated', { chatId, name: groupName, groupId });
                }
            }
            socket.emit('createGroupChatResponse', { success: true, chatId, groupId });
        } catch (error) {
            socket.emit('createGroupChatResponse', { success: false, message: '創建群組失敗: ' + error.message });
        }
    });

    socket.on('chatMessage', async (data) => {
        try {
            const { chatId, fromUid, message, timestamp } = data;
            const chat = await db.collection('chats').findOne({ chatId });
            if (!chat || !chat.members.includes(fromUid)) {
                socket.emit('chatMessageFailed', { chatId, message: '無效聊天' });
                return;
            }
            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            const messageData = { chatId, fromUid, message, nickname: fromUser.nickname, timestamp };
            await db.collection('chatMessages').updateOne(
                { chatId },
                { $push: { messages: messageData } },
                { upsert: true }
            );
            for (const userId of chat.members) {
                const user = await db.collection('users').findOne({ uid: userId });
                if (user.online && user.socketId) {
                    io.to(user.socketId).emit('chatMessage', messageData);
                }
            }
        } catch (error) {
            socket.emit('chatMessageFailed', { chatId: data.chatId, message: '發送失敗: ' + error.message });
        }
    });

    socket.on('groupMessage', async (data) => {
        try {
            const { chatId, fromUid, message, timestamp } = data;
            const groupChat = await db.collection('groupChats').findOne({ chatId });
            if (!groupChat || !groupChat.members.includes(fromUid)) {
                socket.emit('groupMessageFailed', { chatId, message: '無效群聊' });
                return;
            }
            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            const messageData = { chatId, fromUid, message, nickname: fromUser.nickname, timestamp };
            await db.collection('groupChatMessages').updateOne(
                { chatId },
                { $push: { messages: messageData } },
                { upsert: true }
            );
            for (const userId of groupChat.members) {
                const user = await db.collection('users').findOne({ uid: userId });
                if (user.online && user.socketId) {
                    io.to(user.socketId).emit('groupMessage', messageData);
                }
            }
        } catch (error) {
            socket.emit('groupMessageFailed', { chatId: data.chatId, message: '發送失敗: ' + error.message });
        }
    });

    socket.on('getChatHistory', async (data) => {
        try {
            const { chatId } = data;
            let messages = [];
            const privateChat = await db.collection('chats').findOne({ chatId });
            if (privateChat) {
                const messagesDoc = await db.collection('chatMessages').findOne({ chatId });
                messages = messagesDoc ? messagesDoc.messages : [];
            } else {
                const groupChat = await db.collection('groupChats').findOne({ chatId });
                if (groupChat) {
                    const messagesDoc = await db.collection('groupChatMessages').findOne({ chatId });
                    messages = messagesDoc ? messagesDoc.messages : [];
                } else {
                    socket.emit('getChatHistoryResponse', { success: false, message: '聊天不存在' });
                    return;
                }
            }
            messages.sort((a, b) => a.timestamp - b.timestamp);
            socket.emit('getChatHistoryResponse', { success: true, messages });
        } catch (error) {
            socket.emit('getChatHistoryResponse', { success: false, message: '獲取記錄失敗: ' + error.message });
        }
    });

    socket.on('leaveGroup', async (data) => {
        try {
            const { groupId, uid } = data;
            const groupChat = await db.collection('groupChats').findOne({ groupId });
            if (!groupChat || !groupChat.members.includes(uid)) {
                socket.emit('leaveGroupResponse', { success: false, message: '無效操作' });
                return;
            }
            await db.collection('groupChats').updateOne(
                { groupId },
                { $pull: { members: uid } }
            );
            const updatedGroup = await db.collection('groupChats').findOne({ groupId });
            if (groupChat.adminUid === uid && updatedGroup.members.length > 0) {
                await db.collection('groupChats').updateOne(
                    { groupId },
                    { $set: { adminUid: updatedGroup.members[0] } }
                );
            }
            const user = await db.collection('users').findOne({ uid });
            const messageData = {
                chatId: groupChat.chatId,
                type: 'system',
                message: `${user.nickname} 已離開群組`,
                timestamp: Date.now()
            };
            await db.collection('groupChatMessages').updateOne(
                { chatId: groupChat.chatId },
                { $push: { messages: messageData } }
            );
            for (const userId of updatedGroup.members) {
                const member = await db.collection('users').findOne({ uid: userId });
                if (member.online && member.socketId) {
                    io.to(member.socketId).emit('groupMessage', messageData);
                }
            }
            socket.emit('leaveGroupResponse', { success: true, message: '已離開群組' });
        } catch (error) {
            socket.emit('leaveGroupResponse', { success: false, message: '離開失敗: ' + error.message });
        }
    });
});

function generateUid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
