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
const groupChats = new Map(); // chatId -> {type: 'group', groupId, name, password, adminUid, members: [uids]}

// 儲存聊天訊息歷史
const chatMessages = new Map(); // chatId -> [{fromUid, message, nickname, timestamp}]
const groupChatMessages = new Map(); // chatId -> [{fromUid, message, nickname, timestamp}]

// 儲存離線好友請求和群組加入請求
const pendingFriendRequests = new Map(); // toUid -> [{fromUid, fromNickname, timestamp}]
const pendingGroupJoinRequests = new Map(); // groupId -> [{fromUid, fromNickname, timestamp}]

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send('Anonymous Chat Server');
});

app.use((err, req, res, next) => {
    console.error('Server error:', err.stack);
    res.status(500).send('Server error');
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('error', (error) => {
        console.error(`Socket error: ${socket.id}, Error: ${error.message}`);
    });

    socket.on('disconnect', (reason) => {
        console.log(`User disconnected: ${socket.id}, Reason: ${reason}`);
        for (let [uid, user] of users.entries()) {
            if (user.socket === socket) {
                users.delete(uid);
                break;
            }
        }
    });

    socket.on('register', (data) => {
        console.log('Received register request:', data);
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
                socket.emit('registerResponse', { success: false, message: 'Username already exists' });
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
                friends: []
            });

            socket.emit('registerResponse', { success: true, uid });
        } catch (error) {
            console.error('Failed to process register:', error);
            socket.emit('registerResponse', { success: false, message: 'Registration failed: ' + error.message });
        }
    });

    socket.on('login', (data) => {
        console.log('Received login request:', data);
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
                    nickname: foundUser.nickname || username
                });

                // 檢查是否有未處理的好友請求
                if (pendingFriendRequests.has(uid)) {
                    const requests = pendingFriendRequests.get(uid);
                    requests.forEach(request => {
                        socket.emit('friendRequest', {
                            fromUid: request.fromUid,
                            fromNickname: request.fromNickname
                        });
                    });
                    pendingFriendRequests.delete(uid);
                }

                // 檢查是否有未處理的群組加入請求
                for (let [groupId, requests] of pendingGroupJoinRequests.entries()) {
                    const groupChat = Array.from(groupChats.entries()).find(([_, group]) => group.groupId === groupId)?.[1];
                    if (groupChat && groupChat.adminUid === uid) {
                        requests.forEach(request => {
                            socket.emit('joinGroupRequest', {
                                groupId,
                                fromUid: request.fromUid,
                                fromNickname: request.fromNickname
                            });
                        });
                        pendingGroupJoinRequests.delete(groupId);
                    }
                }
            } else {
                socket.emit('loginResponse', { success: false, message: 'Invalid username or password' });
            }
        } catch (error) {
            console.error('Failed to process login:', error);
            socket.emit('loginResponse', { success: false, message: 'Login failed: ' + error.message });
        }
    });

    socket.on('updateNickname', (data) => {
        console.log('Received update nickname request:', data);
        try {
            const { uid, nickname } = data;

            if (!users.has(uid)) {
                socket.emit('updateNicknameResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const user = users.get(uid);
            user.nickname = nickname;

            for (let [otherUid, otherUser] of users.entries()) {
                otherUser.friends = otherUser.friends.map(friend =>
                    friend.uid === uid ? { uid, nickname } : friend
                );
            }

            socket.emit('updateNicknameResponse', { success: true, nickname });
        } catch (error) {
            console.error('Failed to process update nickname:', error);
            socket.emit('updateNicknameResponse', { success: false, message: 'Update nickname failed: ' + error.message });
        }
    });

    socket.on('friendRequest', (data) => {
        console.log('Received friend request:', data);
        try {
            const { fromUid, toUid } = data;

            if (!users.has(fromUid) || !users.has(toUid)) {
                socket.emit('friendRequestResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const fromUser = users.get(fromUid);
            const toUser = users.get(toUid);

            if (fromUser.friends.some(f => f.uid === toUid)) {
                socket.emit('friendRequestResponse', { success: false, message: 'Already friends' });
                return;
            }

            if (toUser.socket && toUser.socket.connected) {
                toUser.socket.emit('friendRequest', {
                    fromUid,
                    fromNickname: fromUser.nickname
                });
                socket.emit('friendRequestResponse', { success: true });
            } else {
                if (!pendingFriendRequests.has(toUid)) {
                    pendingFriendRequests.set(toUid, []);
                }
                pendingFriendRequests.get(toUid).push({
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

    socket.on('friendRequestByNickname', (data) => {
        console.log('Received friend request by nickname:', data);
        try {
            const { fromUid, nickname } = data;

            if (!users.has(fromUid)) {
                socket.emit('friendRequestResponse', { success: false, message: 'User does not exist' });
                return;
            }

            let toUser = null;
            let toUid = null;
            for (let [uid, user] of users.entries()) {
                if (user.nickname.toLowerCase() === nickname.toLowerCase() && uid !== fromUid) {
                    toUser = user;
                    toUid = uid;
                    break;
                }
            }

            if (!toUser) {
                socket.emit('friendRequestResponse', { success: false, message: 'No user found with this nickname' });
                return;
            }

            const fromUser = users.get(fromUid);
            if (fromUser.friends.some(f => f.uid === toUid)) {
                socket.emit('friendRequestResponse', { success: false, message: 'Already friends' });
                return;
            }

            if (toUser.socket && toUser.socket.connected) {
                toUser.socket.emit('friendRequest', {
                    fromUid,
                    fromNickname: fromUser.nickname
                });
                socket.emit('friendRequestResponse', { success: true });
            } else {
                if (!pendingFriendRequests.has(toUid)) {
                    pendingFriendRequests.set(toUid, []);
                }
                pendingFriendRequests.get(toUid).push({
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

    socket.on('searchUsers', (data) => {
        console.log('Received search users request:', data);
        try {
            const { query, fromUid } = data;
            const results = [];

            for (let [uid, user] of users.entries()) {
                if ((user.nickname.toLowerCase().includes(query.toLowerCase()) || user.username.toLowerCase().includes(query.toLowerCase()) || uid.includes(query)) && uid !== fromUid) {
                    results.push({ uid, nickname: user.nickname });
                }
            }

            socket.emit('searchUsersResponse', { success: true, users: results });
            console.log(`Sent searchUsersResponse to ${socket.id}:`, { success: true, users: results });
        } catch (error) {
            console.error('Failed to process search users:', error);
            socket.emit('searchUsersResponse', { success: false, message: 'Search users failed: ' + error.message });
        }
    });

    socket.on('acceptFriendRequest', (data) => {
        console.log('Received accept friend request:', data);
        try {
            const { fromUid, toUid } = data;

            if (!users.has(fromUid) || !users.has(toUid)) {
                socket.emit('friendRequestFailed', { message: 'User does not exist' });
                return;
            }

            const fromUser = users.get(fromUid);
            const toUser = users.get(toUid);

            if (!fromUser.friends.some(f => f.uid === toUid)) {
                fromUser.friends.push({ uid: toUid, nickname: toUser.nickname });
            }
            if (!toUser.friends.some(f => f.uid === fromUid)) {
                toUser.friends.push({ uid: fromUid, nickname: fromUser.nickname });
            }

            const chatId = generateUid();
            chats.set(chatId, {
                type: 'private',
                members: [fromUid, toUid],
                name: `${fromUser.nickname} & ${toUser.nickname}`
            });
            chatMessages.set(chatId, []);

            if (fromUser.socket && fromUser.socket.connected) {
                fromUser.socket.emit('friendRequestAccepted', {
                    fromUid: toUid,
                    fromNickname: toUser.nickname,
                    chatId
                });
            }
            if (toUser.socket && toUser.socket.connected) {
                toUser.socket.emit('friendRequestAccepted', {
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

    socket.on('rejectFriendRequest', (data) => {
        console.log('Received reject friend request:', data);
        try {
            const { fromUid, toUid } = data;

            if (!users.has(fromUid)) {
                return;
            }

            const fromUser = users.get(fromUid);
            if (fromUser.socket && fromUser.socket.connected) {
                fromUser.socket.emit('friendRequestRejected', { fromUid: toUid });
            }
        } catch (error) {
            console.error('Failed to process reject friend request:', error);
            socket.emit('friendRequestFailed', { message: 'Failed to reject friend request: ' + error.message });
        }
    });

    socket.on('startFriendChat', (data) => {
        console.log('Received start friend chat request:', data);
        try {
            const { fromUid, toUid } = data;

            if (!users.has(fromUid) || !users.has(toUid)) {
                socket.emit('startFriendChatResponse', { success: false, message: 'User does not exist' });
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
                socket.emit('startFriendChatResponse', { success: false, message: 'Chat does not exist' });
                return;
            }

            socket.emit('startFriendChatResponse', { success: true, chatId });
        } catch (error) {
            console.error('Failed to process start friend chat:', error);
            socket.emit('startFriendChatResponse', { success: false, message: 'Failed to start chat: ' + error.message });
        }
    });

    socket.on('createGroupChat', (data) => {
        console.log('Received create group chat request:', data);
        try {
            const { groupName, password, memberUids } = data;

            const validMembers = memberUids.filter(uid => users.has(uid));
            if (validMembers.length === 0) {
                socket.emit('createGroupChatResponse', { success: false, message: 'Invalid member list' });
                return;
            }

            const chatId = generateUid();
            const groupId = generateUid();
            groupChats.set(chatId, {
                type: 'group',
                groupId,
                name: groupName,
                password,
                adminUid: validMembers[0],
                members: validMembers
            });
            groupChatMessages.set(chatId, []);

            validMembers.forEach(uid => {
                const user = users.get(uid);
                if (user.socket && user.socket.connected) {
                    user.socket.emit('groupChatCreated', { chatId, name: groupName, groupId });
                }
            });

            socket.emit('createGroupChatResponse', { success: true, chatId, groupId });
        } catch (error) {
            console.error('Failed to process create group chat:', error);
            socket.emit('createGroupChatResponse', { success: false, message: 'Failed to create group chat: ' + error.message });
        }
    });

    socket.on('searchGroups', (data) => {
        console.log('Received search groups request:', data);
        try {
            const { query, fromUid } = data;
            const results = [];

            for (let [chatId, group] of groupChats.entries()) {
                if ((group.name.toLowerCase().includes(query.toLowerCase()) || group.groupId.includes(query)) && !group.members.includes(fromUid)) {
                    results.push({
                        chatId,
                        groupId: group.groupId,
                        name: group.name,
                        adminUid: group.adminUid
                    });
                }
            }

            socket.emit('searchGroupsResponse', { success: true, groups: results });
        } catch (error) {
            console.error('Failed to process search groups:', error);
            socket.emit('searchGroupsResponse', { success: false, message: 'Search groups failed: ' + error.message });
        }
    });

    socket.on('joinGroupRequest', (data) => {
        console.log('Received join group request:', data);
        try {
            const { groupId, password, fromUid } = data;

            let groupChat = null;
            let chatId = null;
            for (let [id, group] of groupChats.entries()) {
                if (group.groupId === groupId) {
                    groupChat = group;
                    chatId = id;
                    break;
                }
            }

            if (!groupChat) {
                socket.emit('joinGroupResponse', { success: false, message: 'Group does not exist' });
                return;
            }

            if (groupChat.password !== password) {
                socket.emit('joinGroupResponse', { success: false, message: 'Incorrect password' });
                return;
            }

            if (!users.has(fromUid) || !users.has(groupChat.adminUid)) {
                socket.emit('joinGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            if (groupChat.members.includes(fromUid)) {
                socket.emit('joinGroupResponse', { success: false, message: 'Already a group member' });
                return;
            }

            const fromUser = users.get(fromUid);
            const adminUser = users.get(groupChat.adminUid);
            if (adminUser.socket && adminUser.socket.connected) {
                adminUser.socket.emit('joinGroupRequest', {
                    groupId,
                    fromUid,
                    fromNickname: fromUser.nickname
                });
                socket.emit('joinGroupResponse', { success: true });
            } else {
                if (!pendingGroupJoinRequests.has(groupId)) {
                    pendingGroupJoinRequests.set(groupId, []);
                }
                pendingGroupJoinRequests.get(groupId).push({
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

    socket.on('approveJoinGroup', (data) => {
        console.log('Received approve join group request:', data);
        try {
            const { groupId, fromUid, toUid } = data;

            let groupChat = null;
            let chatId = null;
            for (let [id, group] of groupChats.entries()) {
                if (group.groupId === groupId) {
                    groupChat = group;
                    chatId = id;
                    break;
                }
            }

            if (!groupChat || groupChat.adminUid !== toUid || !users.has(fromUid)) {
                socket.emit('joinGroupResponse', { success: false, message: 'Invalid request or user does not exist' });
                return;
            }

            if (!groupChat.members.includes(fromUid)) {
                groupChat.members.push(fromUid);
            }
            const fromUser = users.get(fromUid);
            if (fromUser.socket && fromUser.socket.connected) {
                fromUser.socket.emit('joinGroupApproved', {
                    chatId,
                    name: groupChat.name
                });
            }
            socket.emit('joinGroupResponse', { success: true, message: 'User added to group' });

            const messageData = {
                chatId,
                type: 'system',
                message: `${fromUser.nickname} has joined the group`,
                timestamp: Date.now()
            };
            groupChatMessages.get(chatId).push(messageData);
            groupChat.members.forEach(userId => {
                if (users.has(userId) && users.get(userId).socket && users.get(userId).socket.connected) {
                    const user = users.get(userId);
                    user.socket.emit('groupMessage', messageData);
                }
            });
        } catch (error) {
            console.error('Failed to process approve join group:', error);
            socket.emit('joinGroupResponse', { success: false, message: 'Failed to approve join group: ' + error.message });
        }
    });

    socket.on('rejectJoinGroup', (data) => {
        console.log('Received reject join group request:', data);
        try {
            const { groupId, fromUid } = data;

            if (!users.has(fromUid)) {
                socket.emit('joinGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const fromUser = users.get(fromUid);
            if (fromUser.socket && fromUser.socket.connected) {
                fromUser.socket.emit('joinGroupRejected', { groupId });
            }
            socket.emit('joinGroupResponse', { success: true, message: 'Join request rejected' });
        } catch (error) {
            console.error('Failed to process reject join group:', error);
            socket.emit('joinGroupResponse', { success: false, message: 'Failed to reject join group: ' + error.message });
        }
    });

    socket.on('inviteToGroup', (data) => {
        console.log('Received invite friends to group request:', data);
        try {
            const { fromUid, friendUids, groupId } = data;

            if (!users.has(fromUid)) {
                socket.emit('inviteToGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            let groupChat = null;
            let chatId = null;
            for (let [id, group] of groupChats.entries()) {
                if (group.groupId === groupId) {
                    groupChat = group;
                    chatId = id;
                    break;
                }
            }

            if (!groupChat) {
                socket.emit('inviteToGroupResponse', { success: false, message: 'Group does not exist' });
                return;
            }

            if (groupChat.adminUid !== fromUid) {
                socket.emit('inviteToGroupResponse', { success: false, message: 'You are not the group admin' });
                return;
            }

            const fromUser = users.get(fromUid);
            friendUids.forEach(friendUid => {
                if (users.has(friendUid) && !groupChat.members.includes(friendUid)) {
                    const friend = users.get(friendUid);
                    if (friend.socket && friend.socket.connected) {
                        friend.socket.emit('inviteToGroup', {
                            groupId: groupChat.groupId,
                            groupName: groupChat.name,
                            fromUid,
                            fromNickname: fromUser.nickname
                        });
                    }
                }
            });

            socket.emit('inviteToGroupResponse', { success: true });
        } catch (error) {
            console.error('Failed to process invite friends to group:', error);
            socket.emit('inviteToGroupResponse', { success: false, message: 'Failed to invite friends: ' + error.message });
        }
    });

    socket.on('acceptGroupInvite', (data) => {
        console.log('Received accept group invite:', data);
        try {
            const { groupId, fromUid, toUid } = data;

            let groupChat = null;
            let chatId = null;
            for (let [id, group] of groupChats.entries()) {
                if (group.groupId === groupId) {
                    groupChat = group;
                    chatId = id;
                    break;
                }
            }

            if (!groupChat || !users.has(toUid)) {
                socket.emit('joinGroupResponse', { success: false, message: 'Group or user does not exist' });
                return;
            }

            if (!groupChat.members.includes(toUid)) {
                groupChat.members.push(toUid);
            }
            const toUser = users.get(toUid);
            if (toUser.socket && toUser.socket.connected) {
                toUser.socket.emit('joinGroupApproved', {
                    chatId,
                    name: groupChat.name
                });
            }
            socket.emit('joinGroupResponse', { success: true, message: 'Joined group successfully' });

            const messageData = {
                chatId,
                type: 'system',
                message: `${toUser.nickname} has joined the group`,
                timestamp: Date.now()
            };
            groupChatMessages.get(chatId).push(messageData);
            groupChat.members.forEach(userId => {
                if (users.has(userId) && users.get(userId).socket && users.get(userId).socket.connected) {
                    const user = users.get(userId);
                    user.socket.emit('groupMessage', messageData);
                }
            });
        } catch (error) {
            console.error('Failed to process accept group invite:', error);
            socket.emit('joinGroupResponse', { success: false, message: 'Failed to accept group invite: ' + error.message });
        }
    });

    socket.on('rejectGroupInvite', (data) => {
        console.log('Received reject group invite:', data);
        try {
            const { groupId, fromUid, toUid } = data;

            if (!users.has(fromUid)) {
                socket.emit('joinGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const fromUser = users.get(fromUid);
            if (fromUser.socket && fromUser.socket.connected) {
                fromUser.socket.emit('groupInviteRejected', { groupId, toUid });
            }
            socket.emit('joinGroupResponse', { success: true, message: 'Group invite rejected' });
        } catch (error) {
            console.error('Failed to process reject group invite:', error);
            socket.emit('joinGroupResponse', { success: false, message: 'Failed to reject group invite: ' + error.message });
        }
    });

    socket.on('leaveGroup', (data) => {
        console.log('Received leave group request:', data);
        try {
            const { groupId, uid } = data;

            let groupChat = null;
            let chatId = null;
            for (let [id, group] of groupChats.entries()) {
                if (group.groupId === groupId) {
                    groupChat = group;
                    chatId = id;
                    break;
                }
            }

            if (!groupChat) {
                socket.emit('leaveGroupResponse', { success: false, message: 'Group does not exist' });
                return;
            }

            if (!users.has(uid)) {
                socket.emit('leaveGroupResponse', { success: false, message: 'User does not exist' });
                return;
            }

            if (!groupChat.members.includes(uid)) {
                socket.emit('leaveGroupResponse', { success: false, message: 'Not a group member' });
                return;
            }

            groupChat.members = groupChat.members.filter(memberUid => memberUid !== uid);
            const user = users.get(uid);

            if (groupChat.adminUid === uid) {
                if (groupChat.members.length > 0) {
                    groupChat.adminUid = groupChat.members[0];
                } else {
                    groupChats.delete(chatId);
                    groupChatMessages.delete(chatId);
                }
            }

            if (groupChat.members.length > 0) {
                const messageData = {
                    chatId,
                    type: 'system',
                    message: `${user.nickname} has left the group`,
                    timestamp: Date.now()
                };
                groupChatMessages.get(chatId).push(messageData);
                groupChat.members.forEach(userId => {
                    if (users.has(userId) && users.get(userId).socket && users.get(userId).socket.connected) {
                        const member = users.get(userId);
                        member.socket.emit('groupMessage', messageData);
                    }
                });
            }

            socket.emit('leaveGroupResponse', { success: true, message: 'Left group successfully' });
        } catch (error) {
            console.error('Failed to process leave group:', error);
            socket.emit('leaveGroupResponse', { success: false, message: 'Failed to leave group: ' + error.message });
        }
    });

    socket.on('chatMessage', (data) => {
        console.log('Received chat message:', data);
        try {
            const { chatId, fromUid, message } = data;

            if (!chats.has(chatId)) {
                socket.emit('chatMessageFailed', { message: 'Chat does not exist' });
                return;
            }

            const chat = chats.get(chatId);
            if (!chat.members.includes(fromUid)) {
                socket.emit('chatMessageFailed', { message: 'Not a chat member' });
                return;
            }

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
                if (users.has(userId) && userId !== fromUid && users.get(userId).socket && users.get(userId).socket.connected) {
                    const user = users.get(userId);
                    user.socket.emit('chatMessage', messageData);
                }
            });
        } catch (error) {
            console.error('Failed to process chat message:', error);
            socket.emit('chatMessageFailed', { message: 'Failed to send message: ' + error.message });
        }
    });

    socket.on('groupMessage', (data) => {
        console.log('Received group message:', data);
        try {
            const { chatId, fromUid, message } = data;

            if (!groupChats.has(chatId)) {
                socket.emit('groupMessageFailed', { message: 'Group chat does not exist' });
                return;
            }

            const groupChat = groupChats.get(chatId);
            if (!groupChat.members.includes(fromUid)) {
                socket.emit('groupMessageFailed', { message: 'Not a group member' });
                return;
            }

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
                if (users.has(userId) && users.get(userId).socket && users.get(userId).socket.connected) {
                    const user = users.get(userId);
                    user.socket.emit('groupMessage', messageData);
                    console.log(`Sent groupMessage to ${userId} (Socket ID: ${user.socket.id}):`, messageData);
                } else {
                    console.log(`User ${userId} is offline or socket not connected, message stored for later delivery`);
                }
            });
        } catch (error) {
            console.error('Failed to process group message:', error);
            socket.emit('groupMessageFailed', { message: 'Failed to send group message: ' + error.message });
        }
    });

    socket.on('getChatList', (data) => {
        console.log('Received get chat list request:', data);
        try {
            const { uid } = data;
            if (!users.has(uid)) {
                socket.emit('getChatListResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const chatList = [];
            const seenChatIds = new Set();

            for (let [chatId, chat] of chats.entries()) {
                if (chat.members.includes(uid) && !seenChatIds.has(chatId)) {
                    seenChatIds.add(chatId);
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
                if (groupChat.members.includes(uid) && !seenChatIds.has(chatId)) {
                    seenChatIds.add(chatId);
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
            console.error('Failed to process get chat list:', error);
            socket.emit('getChatListResponse', { success: false, message: 'Failed to get chat list: ' + error.message });
        }
    });

    socket.on('getFriendList', (data) => {
        console.log('Received get friend list request:', data);
        try {
            const { uid } = data;
            if (!users.has(uid)) {
                socket.emit('getFriendListResponse', { success: false, message: 'User does not exist' });
                return;
            }

            const user = users.get(uid);
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

    socket.on('getChatHistory', (data) => {
        console.log('Received get chat history request:', data);
        try {
            const { chatId } = data;
            let messages = [];

            if (chats.has(chatId)) {
                messages = chatMessages.get(chatId) || [];
            } else if (groupChats.has(chatId)) {
                messages = groupChatMessages.get(chatId) || [];
            } else {
                socket.emit('getChatHistoryResponse', { success: false, message: 'Chat does not exist' });
                return;
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

http.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
