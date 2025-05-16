const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000,
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'], // 支持 WebSocket 和 polling，適配5G
    allowEIO3: true, // 兼容舊版客戶端
    maxHttpBufferSize: 1e7, // 增加緩衝區，適配5G高速傳輸
    perMessageDeflate: false // 禁用壓縮，降低5G延遲
});
const { MongoClient } = require('mongodb');
const port = process.env.PORT || 10000;

// MongoDB 連線設定
const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
});
let db;

// 連接到 MongoDB，帶重試邏輯
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
            await db.collection("groupChatMessages");
            await db.createCollection("pendingRequests");
            return;
        } catch (error) {
            console.error(`Failed to connect to MongoDB (attempt ${6 - retries}/5):`, error);
            retries--;
            if (retries === 0) {
                console.error("Exhausted all retries, exiting...");
                process.exit(1);
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// 啟動伺服器
connectToMongo().then(() => {
    http.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}).catch(err => {
    console.error("Failed to start server due to MongoDB connection error:", err);
    process.exit(1);
});

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send('Anonymous Chat Server');
});

app.use((err, req, res, next) => {
    console.error('Server error:', err.stack);
    res.status(500).send('Server error');
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}, Transport: ${socket.conn.transport.name}`);

    // 監聽傳輸層切換
    socket.conn.on('upgrade', () => {
        console.log(`Transport upgraded for ${socket.id}: ${socket.conn.transport.name}`);
    });

    socket.on('error', (error) => {
        console.error(`Socket error: ${socket.id}, Error: ${error.message}, Transport: ${socket.conn.transport.name}`);
    });

    socket.on('disconnect', (reason) => {
        console.log(`User disconnected: ${socket.id}, Reason: ${reason}, Transport: ${socket.conn.transport.name}`);
        db.collection('users').updateOne(
            { socketId: socket.id },
            { $set: { online: false, socketId: null } }
        );
    });

    socket.on('register', async (data) => {
        console.log('Received register request:', data);
        try {
            const { username, password, nickname, deviceInfo } = data;

            const existingUser = await db.collection('users').findOne({ username });
            if (existingUser) {
                socket.emit('registerResponse', { success: false, message: 'Username already exists' });
                return;
            }

            const uid = generateUid();
            await db.collection('users').insertOne({
                uid,
                username,
                password,
                nickname: nickname || username,
                socketId: socket.id,
                online: true,
                deviceInfo: {
                    ipAddress: socket.handshake.address,
                    androidId: deviceInfo?.androidId || 'unknown',
                    model: deviceInfo?.model || 'unknown',
                    osVersion: deviceInfo?.osVersion || 'unknown',
                    networkType: deviceInfo?.networkType || 'unknown' // 記錄網路類型
                },
                friends: []
            });

            socket.emit('registerResponse', { success: true, uid });
        } catch (error) {
            console.error('Failed to process register:', error);
            socket.emit('registerResponse', { success: false, message: 'Registration failed: ' + error.message });
        }
    });

    socket.on('login', async (data) => {
        console.log('Received login request:', data);
        try {
            const { username, password, deviceInfo } = data;

            const user = await db.collection('users').findOne({ username, password });
            if (user) {
                await db.collection('users').updateOne(
                    { uid: user.uid },
                    {
                        $set: {
                            socketId: socket.id,
                            online: true,
                            deviceInfo: {
                                ipAddress: socket.handshake.address,
                                androidId: deviceInfo?.androidId || 'unknown',
                                model: deviceInfo?.model || 'unknown',
                                osVersion: deviceInfo?.osVersion || 'unknown',
                                networkType: deviceInfo?.networkType || 'unknown' // 記錄網路類型
                            }
                        }
                    }
                );

                socket.emit('loginResponse', {
                    success: true,
                    uid: user.uid,
                    username,
                    nickname: user.nickname || username
                });

                const userChats = await db.collection('chats').find({ members: user.uid }).toArray();
                for (const chat of userChats) {
                    const messages = await db.collection('chatMessages').find({ chatId: chat.chatId }).toArray();
                    messages.forEach(message => {
                        socket.emit('chatMessage', message);
                    });
                }

                const userGroupChats = await db.collection('groupChats').find({ members: user.uid }).toArray();
                for (const groupChat of userGroupChats) {
                    const messages = await db.collection('groupChatMessages').find({ chatId: groupChat.chatId }).toArray();
                    messages.forEach(message => {
                        socket.emit('groupMessage', message);
                    });
                }

                const requests = await db.collection('pendingRequests').find({ toUid: user.uid }).toArray();
                requests.forEach(request => {
                    if (request.type === 'friend') {
                        socket.emit('friendRequest', {
                            fromUid: request.fromUid,
                            fromNickname: request.fromNickname
                        });
                    } else if (request.type === 'group') {
                        socket.emit('inviteToGroup', {
                            groupId: request.groupId,
                            groupName: request.groupName,
                            fromUid: request.fromUid,
                            fromNickname: request.fromNickname
                        });
                    }
                });
                await db.collection('pendingRequests').deleteMany({ toUid: user.uid });

                const adminGroups = await db.collection('groupChats').find({ adminUid: user.uid }).toArray();
                for (const group of adminGroups) {
                    const groupRequests = await db.collection('pendingRequests').find({ groupId: group.groupId, type: 'joinGroup' }).toArray();
                    groupRequests.forEach(request => {
                        socket.emit('joinGroupRequest', {
                            groupId: group.groupId,
                            fromUid: request.fromUid,
                            fromNickname: request.fromNickname
                        });
                    });
                }
            } else {
                socket.emit('loginResponse', { success: false, message: 'Invalid username or password' });
            }
        } catch (error) {
            console.error('Failed to process login:', error);
            socket.emit('loginResponse', { success: false, message: 'Login failed: ' + error.message });
        }
    });

    socket.on('updateNickname', async (data) => {
        console.log('Received update nickname request:', data);
        try {
            const { uid, nickname } = data;

            const user = await db.collection('users').findOne({ uid });
            if (!user) {
                socket.emit('updateNicknameResponse', { success: false, message: 'User does not exist' });
                return;
            }

            await db.collection('users').updateOne(
                { uid },
                { $set: { nickname } }
            );

            await db.collection('users').updateMany(
                { "friends.uid": uid },
                { $set: { "friends.$.nickname": nickname } }
            );

            socket.emit('updateNicknameResponse', { success: true, nickname });
        } catch (error) {
            console.error('Failed to process update nickname:', error);
            socket.emit('updateNicknameResponse', { success: false, message: 'Update nickname failed: ' + error.message });
        }
    });

    socket.on('friendRequest', async (data) => {
        console.log('Received friend request:', data);
        try {
            const { fromUid, toUid } = data;

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            const toUser = await db.collection('users').findOne({ uid: toUid });

            if (! fromUser || !toUser) {
                socket.emit('friendRequestResponse', { success: false, message: 'User does not exist' });
                return;
            }

            if (fromUser.friends.some(f => f.uid === toUid)) {
                socket.emit('friendRequestResponse', { success: false, message: 'Already friends' });
                return;
            }

            if (toUser.online && toUser.socketId) {
                io.to(toUser.socketId).emit('friendRequest', {
                    fromUid,
                    fromNickname: fromUser.nickname
                });
                socket.emit('friendRequestResponse', { success: true });
            } else {
                await db.collection('pendingRequests').insertOne({
                    type: 'friend',
                    toUid,
                    fromUid,
                    fromNickname: fromUser.nickname,
                    timestamp: Date.now()
                });
                socket.emit('friendRequestResponse', { success: true });
            }
        } catch (error) {
            console.error('Failed to process friend request:', error);
            socket.emit('friendRequestResponse', { success: false, message: 'Failed to send friend request: ' + error.message });
        }
    });

    socket.on('friendRequestByNickname', async (data) => {
        console.log('Received friend request by nickname:', data);
        try {
            const { fromUid, nickname } = data;

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            if (!fromUser) {
                socket.emit('friendRequestResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const toUser = await db.collection('users').findOne({ nickname: new RegExp('^' + nickname + '$', 'i'), uid: { $ne: fromUid } });
            if (!toUser) {
                socket.emit('friendRequestResponse', { success: false, message: 'No user found with this nickname' });
                return;
            }

            const toUid = toUser.uid;
            if (fromUser.friends.some(f => f.uid === toUid)) {
                socket.emit('friendRequestResponse', { success: false, message: 'Already friends' });
                return;
            }

            if (toUser.online && toUser.socketId) {
                io.to(toUser.socketId).emit('friendRequest', {
                    fromUid,
                    fromNickname: fromUser.nickname
                });
                socket.emit('friendRequestResponse', { success: true });
            } else {
                await db.collection('pendingRequests').insertOne({
                    type: 'friend',
                    toUid,
                    fromUid,
                    fromNickname: fromUser.nickname,
                    timestamp: Date.now()
                });
                socket.emit('friendRequestResponse', { success: true });
            }
        } catch (error) {
            console.error('Failed to process friend request by nickname:', error);
            socket.emit('friendRequestResponse', { success: false, message: 'Failed to send friend request: ' + error.message });
        }
    });

    socket.on('searchUsers', async (data) => {
        console.log('Received search users request:', data);
        try {
            const { query, fromUid } = data;
            const results = [];

            const users = await db.collection('users').find({
                $or: [
                    { nickname: { $regex: query, $options: 'i' } },
                    { username: { $regex: query, $options: 'i' } },
                    { uid: { $regex: query, $options: 'i' } }
                ],
                uid: { $ne: fromUid }
            }).toArray();

            users.forEach(user => {
                results.push({ uid: user.uid, nickname: user.nickname, online: user.online });
            });

            socket.emit('searchUsersResponse', { success: true, users: results });
            console.log(`Sent searchUsersResponse to ${socket.id}:`, { success: true, users: results });
        } catch (error) {
            console.error('Failed to process search users:', error);
            socket.emit('searchUsersResponse', { success: false, message: 'Search users failed: ' + error.message });
        }
    });

    socket.on('acceptFriendRequest', async (data) => {
        console.log('Received accept friend request:', data);
        try {
            const { fromUid, toUid } = data;

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            const toUser = await db.collection('users').findOne({ uid: toUid });

            if (!fromUser || !toUser) {
                socket.emit('friendRequestFailed', { message: 'User does not exist' });
                return;
            }

            if (!fromUser.friends.some(f => f.uid === toUid)) {
                await db.collection('users').updateOne(
                    { uid: fromUid },
                    { $push: { friends: { uid: toUid, nickname: toUser.nickname } } }
                );
            }
            if (!toUser.friends.some(f => f.uid === fromUid)) {
                await db.collection('users').updateOne(
                    { uid: toUid },
                    { $push: { friends: { uid: fromUid, nickname: fromUser.nickname } } }
                );
            }

            const chatId = generateUid();
            await db.collection('chats').insertOne({
                chatId,
                type: 'private',
                members: [fromUid, toUid],
                name: `${fromUser.nickname} & ${toUser.nickname}`
            });
            await db.collection('chatMessages').insertOne({ chatId, messages: [] });

            if (fromUser.online && fromUser.socketId) {
                io.to(fromUser.socketId).emit('friendRequestAccepted', {
                    fromUid: toUid,
                    fromNickname: toUser.nickname,
                    chatId
                });
            }
            if (toUser.online && toUser.socketId) {
                io.to(toUser.socketId).emit('friendRequestAccepted', {
                    fromUid,
                    fromNickname: fromUser.nickname,
                    chatId
                });
            }
        } catch (error) {
            console.error('Failed to process accept friend request:', error);
            socket.emit('friendRequestFailed', { message: 'Failed to accept friend request: ' + error.message });
        }
    });

    socket.on('rejectFriendRequest', async (data) => {
        console.log('Received reject friend request:', data);
        try {
            const { fromUid, toUid } = data;

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            if (fromUser && fromUser.online && fromUser.socketId) {
                io.to(fromUser.socketId).emit('friendRequestRejected', { fromUid: toUid });
            }
        } catch (error) {
            console.error('Failed to process reject friend request:', error);
            socket.emit('friendRequestFailed', { message: 'Failed to reject friend request: ' + error.message });
        }
    });

    socket.on('startFriendChat', async (data) => {
        console.log('Received start friend chat request:', data);
        try {
            const { fromUid, toUid } = data;

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            const toUser = await db.collection('users').findOne({ uid: toUid });

            if (!fromUser || !toUser) {
                socket.emit('startFriendChatResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const chat = await db.collection('chats').findOne({
                type: 'private',
                members: { $all: [fromUid, toUid] }
            });

            if (!chat) {
                socket.emit('startFriendChatResponse', { success: false, message: 'Chat does not exist' });
                return;
            }

            socket.emit('startFriendChatResponse', { success: true, chatId: chat.chatId });
        } catch (error) {
            console.error('Failed to process start friend chat:', error);
            socket.emit('startFriendChatResponse', { success: false, message: 'Failed to start chat: ' + error.message });
        }
    });

    socket.on('createGroupChat', async (data) => {
        console.log('Received create group chat request:', data);
        try {
            const { groupName, password, memberUids } = data;

            const validMembers = [];
            for (const uid of memberUids) {
                if (await db.collection('users').findOne({ uid })) {
                    validMembers.push(uid);
                }
            }
            if (validMembers.length === 0) {
                socket.emit('createGroupChatResponse', { success: false, message: 'Invalid member list' });
                return;
            }

            const chatId = generateUid();
            const groupId = generateUid();
            await db.collection('groupChats').insertOne({
                chatId,
                groupId,
                type: 'group',
                name: groupName,
                password,
                adminUid: validMembers[0],
                members: validMembers
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
            console.error('Failed to process create group chat:', error);
            socket.emit('createGroupChatResponse', { success: false, message: 'Failed to create group chat: ' + error.message });
        }
    });

    socket.on('searchGroups', async (data) => {
        console.log('Received search groups request:', data);
        try {
            const { query, password, fromUid } = data;
            const results = [];

            console.log(`Total groups in groupChats: ${await db.collection('groupChats').countDocuments()}`);
            const groups = await db.collection('groupChats').find({
                $or: [
                    { name: { $regex: query, $options: 'i' } },
                    { groupId: { $regex: query, $options: 'i' } }
                ],
                members: { $ne: fromUid }
            }).toArray();

            groups.forEach(group => {
                results.push({
                    chatId: group.chatId,
                    groupId: group.groupId,
                    name: group.name,
                    adminUid: group.adminUid
                });
                console.log(`Found group: ${group.groupId}, name: ${group.name}, members: ${group.members}`);
            });

            if (password) {
                let joined = false;
                for (const group of results) {
                    const groupChat = await db.collection('groupChats').findOne({ groupId: group.groupId });
                    if (groupChat && groupChat.password === password) {
                        if (!groupChat.members.includes(fromUid)) {
                            await db.collection('groupChats').updateOne(
                                { groupId: group.groupId },
                                { $push: { members: fromUid } }
                            );
                            const fromUser = await db.collection('users').findOne({ uid: fromUid });
                            socket.emit('joinGroupApproved', {
                                chatId: group.chatId,
                                name: groupChat.name
                            });

                            const messageData = {
                                chatId: group.chatId,
                                type: 'system',
                                message: `${fromUser.nickname} has joined the group`,
                                timestamp: Date.now()
                            };
                            await db.collection('groupChatMessages').updateOne(
                                { chatId: group.chatId },
                                { $push: { messages: messageData } }
                            );

                            for (const userId of groupChat.members) {
                                const user = await db.collection('users').findOne({ uid: userId });
                                if (user.online && user.socketId) {
                                    io.to(user.socketId).emit('groupMessage', messageData);
                                }
                            }
                            joined = true;
                            socket.emit('searchGroupsResponse', { success: true, joined: true, chatId: group.chatId });
                            return;
                        }
                    }
                }
                if (!joined) {
                    socket.emit('searchGroupsResponse', { success: true, groups: results, message: 'Password incorrect or no matching group found' });
                }
            } else {
                socket.emit('searchGroupsResponse', { success: true, groups: results, message: 'Please provide a password to join directly' });
            }
        } catch (error) {
            console.error('Failed to process search groups:', error);
            socket.emit('searchGroupsResponse', { success: false, message: 'Search groups failed: ' + error.message });
        }
    });

    socket.on('joinGroupRequest', async (data) => {
        console.log('Received join group request:', data);
        try {
            const { groupId, password, fromUid } = data;

            const groupChat = await db.collection('groupChats').findOne({ groupId });
            if (!groupChat) {
                socket.emit('joinGroupResponse', { success: false, message: 'Group does not exist' });
                return;
            }

            if (groupChat.password !== password) {
                socket.emit('joinGroupResponse', { success: false, message: 'Incorrect password' });
                return;
            }

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            const adminUser = await db.collection('users').findOne({ uid: groupChat.adminUid });
            if (!fromUser || !adminUser) {
                socket.emit('joinGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            if (groupChat.members.includes(fromUid)) {
                socket.emit('joinGroupResponse', { success: false, message: 'Already a group member' });
                return;
            }

            if (adminUser.online && adminUser.socketId) {
                io.to(adminUser.socketId).emit('joinGroupRequest', {
                    groupId,
                    fromUid,
                    fromNickname: fromUser.nickname
                });
                socket.emit('joinGroupResponse', { success: true });
            } else {
                await db.collection('pendingRequests').insertOne({
                    type: 'joinGroup',
                    toUid: groupChat.adminUid,
                    groupId,
                    fromUid,
                    fromNickname: fromUser.nickname,
                    timestamp: Date.now()
                });
                socket.emit('joinGroupResponse', { success: true });
            }
        } catch (error) {
            console.error('Failed to process join group request:', error);
            socket.emit('joinGroupResponse', { success: false, message: 'Failed to send join group request: ' + error.message });
        }
    });

    socket.on('approveJoinGroup', async (data) => {
        console.log('Received approve join group request:', data);
        try {
            const { groupId, fromUid, toUid } = data;

            const groupChat = await db.collection('groupChats').findOne({ groupId });
            if (!groupChat || groupChat.adminUid !== toUid) {
                socket.emit('joinGroupResponse', { success: false, message: 'Invalid request or user does not exist' });
                return;
            }

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            if (!fromUser) {
                socket.emit('joinGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            if (!groupChat.members.includes(fromUid)) {
                await db.collection('groupChats').updateOne(
                    { groupId },
                    { $push: { members: fromUid } }
                );
            }

            if (fromUser.online && fromUser.socketId) {
                io.to(fromUser.socketId).emit('joinGroupApproved', {
                    chatId: groupChat.chatId,
                    name: groupChat.name
                });
            }
            socket.emit('joinGroupResponse', { success: true, message: 'User added to group' });

            const messageData = {
                chatId: groupChat.chatId,
                type: 'system',
                message: `${fromUser.nickname} has joined the group`,
                timestamp: Date.now()
            };
            await db.collection('groupChatMessages').updateOne(
                { chatId: groupChat.chatId },
                { $push: { messages: messageData } }
            );

            for (const userId of groupChat.members) {
                const user = await db.collection('users').findOne({ uid: userId });
                if (user.online && user.socketId) {
                    io.to(user.socketId).emit('groupMessage', messageData);
                }
            }
        } catch (error) {
            console.error('Failed to process approve join group:', error);
            socket.emit('joinGroupResponse', { success: false, message: 'Failed to approve join group: ' + error.message });
        }
    });

    socket.on('rejectJoinGroup', async (data) => {
        console.log('Received reject join group request:', data);
        try {
            const { groupId, fromUid } = data;

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            if (!fromUser) {
                socket.emit('joinGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            if (fromUser.online && fromUser.socketId) {
                io.to(fromUser.socketId).emit('joinGroupRejected', { groupId });
            }
            socket.emit('joinGroupResponse', { success: true, message: 'Join request rejected' });
        } catch (error) {
            console.error('Failed to process reject join group:', error);
            socket.emit('joinGroupResponse', { success: false, message: 'Failed to reject join group: ' + error.message });
        }
    });

    socket.on('inviteToGroup', async (data) => {
        console.log('Received invite friends to group request:', data);
        try {
            const { fromUid, friendUids, groupId } = data;

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            if (!fromUser) {
                socket.emit('inviteToGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const groupChat = await db.collection('groupChats').findOne({ groupId });
            if (!groupChat) {
                socket.emit('inviteToGroupResponse', { success: false, message: 'Group does not exist' });
                return;
            }

            if (groupChat.adminUid !== fromUid) {
                socket.emit('inviteToGroupResponse', { success: false, message: 'You are not the group admin' });
                return;
            }

            for (const friendUid of friendUids) {
                if (groupChat.members.includes(friendUid)) continue;
                const friend = await db.collection('users').findOne({ uid: friendUid });
                if (friend) {
                    if (friend.online && friend.socketId) {
                        io.to(friend.socketId).emit('inviteToGroup', {
                            groupId: groupChat.groupId,
                            groupName: groupChat.name,
                            fromUid,
                            fromNickname: fromUser.nickname
                        });
                    } else {
                        await db.collection('pendingRequests').insertOne({
                            type: 'group',
                            toUid: friendUid,
                            groupId: groupChat.groupId,
                            groupName: groupChat.name,
                            fromUid,
                            fromNickname: fromUser.nickname,
                            timestamp: Date.now()
                        });
                    }
                }
            }

            socket.emit('inviteToGroupResponse', { success: true });
        } catch (error) {
            console.error('Failed to process invite friends to group:', error);
            socket.emit('inviteToGroupResponse', { success: false, message: 'Failed to invite friends: ' + error.message });
        }
    });

    socket.on('acceptGroupInvite', async (data) => {
        console.log('Received accept group invite:', data);
        try {
            const { groupId, fromUid, toUid } = data;

            const groupChat = await db.collection('groupChats').findOne({ groupId });
            if (!groupChat) {
                socket.emit('joinGroupResponse', { success: false, message: 'Group does not exist' });
                return;
            }

            const toUser = await db.collection('users').findOne({ uid: toUid });
            if (!toUser) {
                socket.emit('joinGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            if (!groupChat.members.includes(toUid)) {
                await db.collection('groupChats').updateOne(
                    { groupId },
                    { $push: { members: toUid } }
                );
            }

            if (toUser.online && toUser.socketId) {
                io.to(toUser.socketId).emit('joinGroupApproved', {
                    chatId: groupChat.chatId,
                    name: groupChat.name
                });
            }
            socket.emit('joinGroupResponse', { success: true, message: 'Joined group successfully' });

            const messageData = {
                chatId: groupChat.chatId,
                type: 'system',
                message: `${toUser.nickname} has joined the group`,
                timestamp: Date.now()
            };
            await db.collection('groupChatMessages').updateOne(
                { chatId: groupChat.chatId },
                { $push: { messages: messageData } }
            );

            for (const userId of groupChat.members) {
                const user = await db.collection('users').findOne({ uid: userId });
                if (user.online && user.socketId) {
                    io.to(user.socketId).emit('groupMessage', messageData);
                }
            }
        } catch (error) {
            console.error('Failed to process accept group invite:', error);
            socket.emit('joinGroupResponse', { success: false, message: 'Failed to accept group invite: ' + error.message });
        }
    });

    socket.on('rejectGroupInvite', async (data) => {
        console.log('Received reject group invite:', data);
        try {
            const { groupId, fromUid, toUid } = data;

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            if (!fromUser) {
                socket.emit('joinGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            if (fromUser.online && fromUser.socketId) {
                io.to(fromUser.socketId).emit('groupInviteRejected', { groupId, toUid });
            }
            socket.emit('joinGroupResponse', { success: true, message: 'Group invite rejected' });
        } catch (error) {
            console.error('Failed to process reject group invite:', error);
            socket.emit('joinGroupResponse', { success: false, message: 'Failed to reject group invite: ' + error.message });
        }
    });

    socket.on('leaveGroup', async (data) => {
        console.log('Received leave group request:', data);
        try {
            const { groupId, uid } = data;

            const groupChat = await db.collection('groupChats').findOne({ groupId });
            if (!groupChat) {
                socket.emit('leaveGroupResponse', { success: false, message: 'Group does not exist' });
                return;
            }

            const user = await db.collection('users').findOne({ uid });
            if (!user) {
                socket.emit('leaveGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            if (!groupChat.members.includes(uid)) {
                socket.emit('leaveGroupResponse', { success: false, message: 'Not a group member' });
                return;
            }

            await db.collection('groupChats').updateOne(
                { groupId },
                { $pull: { members: uid } }
            );

            const updatedGroup = await db.collection('groupChats').findOne({ groupId });
            if (groupChat.adminUid === uid) {
                if (updatedGroup.members.length > 0) {
                    await db.collection('groupChats').updateOne(
                        { groupId },
                        { $set: { adminUid: updatedGroup.members[0] } }
                    );
                } else {
                    console.log(`Group ${groupId} has no members, but retained for future joins`);
                }
            }

            if (updatedGroup.members.length > 0) {
                const messageData = {
                    chatId: groupChat.chatId,
                    type: 'system',
                    message: `${user.nickname} has left the group`,
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
            }

            socket.emit('leaveGroupResponse', { success: true, message: 'Left group successfully' });
        } catch (error) {
            console.error('Failed to process leave group:', error);
            socket.emit('leaveGroupResponse', { success: false, message: 'Failed to leave group: ' + error.message });
        }
    });

    socket.on('chatMessage', async (data) => {
        console.log('Received chat message:', data, `Transport: ${socket.conn.transport.name}`);
        try {
            const { chatId, fromUid, message, timestamp } = data;

            const chat = await db.collection('chats').findOne({ chatId });
            if (!chat) {
                socket.emit('chatMessageFailed', { chatId, message: 'Chat does not exist' });
                return;
            }

            if (!chat.members.includes(fromUid)) {
                socket.emit('chatMessageFailed', { chatId, message: 'Not a chat member' });
                return;
            }

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            const messageData = {
                chatId,
                fromUid,
                message,
                nickname: fromUser.nickname,
                timestamp: timestamp || Date.now(),
                networkType: fromUser.deviceInfo.networkType || 'unknown' // 記錄網路類型
            };

            await db.collection('chatMessages').updateOne(
                { chatId },
                { $push: { messages: messageData } },
                { upsert: true }
            );

            for (const userId of chat.members) {
                const user = await db.collection('users').findOne({ uid: userId });
                if (user.online && user.socketId) {
                    let retries = 3;
                    while (retries > 0) {
                        try {
                            io.to(user.socketId).emit('chatMessage', messageData);
                            console.log(`Sent chatMessage to ${userId} (Socket ID: ${user.socketId}):`, messageData);
                            break;
                        } catch (emitError) {
                            console.error(`Failed to send chatMessage to ${userId}, retry ${4 - retries}/3:`, emitError);
                            retries--;
                            if (retries === 0) {
                                console.error(`Exhausted retries for ${userId}`);
                            }
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Failed to process chat message:', error, `Transport: ${socket.conn.transport.name}`);
            socket.emit('chatMessageFailed', { chatId: data.chatId, message: 'Failed to send message: ' + error.message });
        }
    });

    socket.on('groupMessage', async (data) => {
        console.log('Received group message:', data, `Transport: ${socket.conn.transport.name}`);
        try {
            const { chatId, fromUid, message, timestamp } = data;

            const groupChat = await db.collection('groupChats').findOne({ chatId });
            if (!groupChat) {
                socket.emit('groupMessageFailed', { chatId, message: 'Group chat does not exist' });
                return;
            }

            if (!groupChat.members.includes(fromUid)) {
                socket.emit('groupMessageFailed', { chatId, message: 'Not a group member' });
                return;
            }

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            const messageData = {
                chatId,
                fromUid,
                message,
                nickname: fromUser.nickname,
                timestamp: timestamp || Date.now(),
                networkType: fromUser.deviceInfo.networkType || 'unknown' // 記錄網路類型
            };

            await db.collection('groupChatMessages').updateOne(
                { chatId },
                { $push: { messages: messageData } },
                { upsert: true }
            );

            for (const userId of groupChat.members) {
                const user = await db.collection('users').findOne({ uid: userId });
                if (user.online && user.socketId) {
                    let retries = 3;
                    while (retries > 0) {
                        try {
                            io.to(user.socketId).emit('groupMessage', messageData);
                            console.log(`Sent groupMessage to ${userId} (Socket ID: ${user.socketId}):`, messageData);
                            break;
                        } catch (emitError) {
                            console.error(`Failed to send groupMessage to ${userId}, retry ${4 - retries}/3:`, emitError);
                            retries--;
                            if (retries === 0) {
                                console.error(`Exhausted retries for ${userId}`);
                            }
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Failed to process group message:', error, `Transport: ${socket.conn.transport.name}`);
            socket.emit('groupMessageFailed', { chatId: data.chatId, message: 'Failed to send group message: ' + error.message });
        }
    });

    socket.on('getChatList', async (data) => {
        console.log('Received get chat list request:', data);
        try {
            const { uid } = data;
            const user = await db.collection('users').findOne({ uid });
            if (!user) {
                socket.emit('getChatListResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const chatList = [];
            const seenChatIds = new Set();

            const privateChats = await db.collection('chats').find({ members: uid }).toArray();
            for (const chat of privateChats) {
                if (!seenChatIds.has(chat.chatId)) {
                    seenChatIds.add(chat.chatId);
                    const messagesDoc = await db.collection('chatMessages').findOne({ chatId: chat.chatId });
                    const messages = messagesDoc ? messagesDoc.messages : [];
                    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                    const otherUserId = chat.members.find(userId => userId !== uid);
                    const otherUser = await db.collection('users').findOne({ uid: otherUserId });
                    chatList.push({
                        chatId: chat.chatId,
                        type: 'private',
                        name: otherUser ? otherUser.nickname : otherUserId,
                        lastMessage
                    });
                }
            }

            const groupChats = await db.collection('groupChats').find({ members: uid }).toArray();
            for (const groupChat of groupChats) {
                if (!seenChatIds.has(groupChat.chatId)) {
                    seenChatIds.add(groupChat.chatId);
                    const messagesDoc = await db.collection('groupChatMessages').findOne({ chatId: groupChat.chatId });
                    const messages = messagesDoc ? messagesDoc.messages : [];
                    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                    chatList.push({
                        chatId: groupChat.chatId,
                        type: 'group',
                        name: groupChat.name,
                        lastMessage
                    });
                }
            }

            socket.emit('getChatListResponse', { success: true, chatList });
        } catch (error) {
            console.error('Failed to process get chat list:', error);
            socket.emit('getChatListResponse', { success: false, message: 'Failed to get chat list: ' + error.message });
        }
    });

    socket.on('getFriendList', async (data) => {
        console.log('Received get friend list request:', data);
        try {
            const { uid } = data;
            const user = await db.collection('users').findOne({ uid });
            if (!user) {
                socket.emit('getFriendListResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const uniqueFriends = [];
            const seenUids = new Set();
            user.friends.forEach(friend => {
                if (!seenUids.has(friend.uid)) {
                    seenUids.add(friend.uid);
                    uniqueFriends.push(friend);
                }
            });

            socket.emit('getFriendListResponse', { success: true, friends: uniqueFriends });
        } catch (error) {
            console.error('Failed to process get friend list:', error);
            socket.emit('getFriendListResponse', { success: false, message: 'Failed to get friend list: ' + error.message });
        }
    });

    socket.on('getChatHistory', async (data) => {
        console.log('Received get chat history request:', data);
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
                    socket.emit('getChatHistoryResponse', { success: false, message: 'Chat does not exist' });
                    return;
                }
            }

            socket.emit('getChatHistoryResponse', { success: true, messages });
        } catch (error) {
            console.error('Failed to process get chat history:', error);
            socket.emit('getChatHistoryResponse', { success: false, message: 'Failed to get chat history: ' + error.message });
        }
    });
});

function generateUid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
