const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000, // 핑 타임아웃 시간 (ms)
    pingInterval: 25000, // 핑 간격 (ms)
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true }, // CORS 설정
    transports: ['websocket', 'polling'], // 통신 방식
    allowEIO3: true, // Socket.IO v2 클라이언트 호환성
    maxHttpBufferSize: 1e7, // HTTP 버퍼 최대 크기 (10MB)
    perMessageDeflate: false // 메시지 압축 비활성화
});
const { MongoClient, ObjectId } = require('mongodb'); // MongoDB 클라이언트 및 ObjectId
const port = process.env.PORT || 10000; // 서버 포트

// MongoDB 연결 URI (환경 변수 또는 기본값 사용)
const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000, // 서버 선택 타임아웃 (ms)
    connectTimeoutMS: 10000, // 연결 타임아웃 (ms)
    useNewUrlParser: true, // 새 URL 파서 사용 (MongoDB 드라이버 버전에 따라 필요 없을 수 있음)
    useUnifiedTopology: true // 통합 토폴로지 사용 (MongoDB 드라이버 버전에 따라 필요 없을 수 있음)
});
let db; // MongoDB 데이터베이스 인스턴스

/**
 * MongoDB에 연결하는 함수
 * 연결 실패 시 재시도 로직 포함
 */
async function connectToMongo() {
    let retries = 5; // 최대 재시도 횟수
    while (retries > 0) {
        try {
            await client.connect(); // MongoDB 연결 시도
            console.log("成功連接到 MongoDB");
            db = client.db("anonymousChat"); // 'anonymousChat' 데이터베이스 선택

            // 필요한 컬렉션 생성 (존재하지 않는 경우)
            const collections = ["users", "privateChats", "groupChats", "messages", "pendingFriendRequests"];
            for (const collectionName of collections) {
                const collectionExists = await db.listCollections({ name: collectionName }).hasNext();
                if (!collectionExists) {
                    await db.createCollection(collectionName);
                    console.log(`已創建集合: ${collectionName}`);
                }
            }
            // users 컬렉션에 인덱스 생성 (username 필드의 고유성 보장)
            await db.collection("users").createIndex({ username: 1 }, { unique: true });
            await db.collection("users").createIndex({ uid: 1 }, { unique: true });
            await db.collection("messages").createIndex({ chatId: 1, timestamp: -1 });


            return; // 연결 성공 시 함수 종료
        } catch (error) {
            console.error(`MongoDB 連接失敗 (第 ${6 - retries}/5 次):`, error);
            retries--; // 재시도 횟수 감소
            if (retries === 0) {
                console.error("無法連接到 MongoDB，伺服器正在關閉。");
                process.exit(1); // 재시도 모두 실패 시 프로세스 종료
            }
            await new Promise(resolve => setTimeout(resolve, 5000)); // 5초 후 재시도
        }
    }
}

// MongoDB 연결 후 서버 시작
connectToMongo().then(() => {
    http.listen(port, () => {
        console.log(`伺服器正在監聽 ${port} 連接埠`);
    });
}).catch(err => {
    console.error("伺服器啟動失敗:", err);
    process.exit(1); // 서버 시작 실패 시 프로세스 종료
});

// 정적 파일 제공 (필요한 경우)
// app.use(express.static('public'));

// 기본 라우트
app.get('/', (req, res) => {
    res.send('匿名聊天伺服器運行中');
});

/**
 * 고유 ID 생성 함수 (UUID v4 형식과 유사)
 * @returns {string} 생성된 UID
 */
function generateUid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Socket.IO 연결 이벤트 핸들러
io.on('connection', (socket) => {
    console.log(`使用者已連接: ${socket.id}`);

    // 사용자 UID를 socket 데이터에 저장 (로그인 후)
    // socket.data.uid = null;

    // 연결 해제 이벤트
    socket.on('disconnect', async () => {
        console.log(`使用者已斷開連接: ${socket.id}`);
        if (socket.data.uid) {
            try {
                // 사용자를 오프라인으로 표시하고 socketId 제거
                await db.collection('users').updateOne(
                    { uid: socket.data.uid },
                    { $set: { online: false, socketId: null, lastSeen: new Date() } }
                );
                console.log(`使用者 ${socket.data.uid} 已離線`);
            } catch (error) {
                console.error("更新使用者離線狀態失敗:", error);
            }
        }
    });

    // 사용자 등록 이벤트
    socket.on('register', async (data) => {
        try {
            const { username, password, nickname, deviceInfo } = data;
            if (!username || !password) {
                socket.emit('registerResponse', { success: false, message: '用戶名和密碼為必填項' });
                return;
            }

            const existingUser = await db.collection('users').findOne({ username });
            if (existingUser) {
                socket.emit('registerResponse', { success: false, message: '用戶名已存在' });
                return;
            }

            const uid = generateUid(); // 고유 사용자 ID 생성
            const newUser = {
                uid,
                username,
                password, // 실제 환경에서는 비밀번호 해싱 필요
                nickname: nickname || username,
                deviceInfo: deviceInfo || {},
                friends: [], // 친구 UID 목록
                blockedUsers: [], // 차단한 사용자 UID 목록
                socketId: socket.id,
                online: true,
                createdAt: new Date(),
                lastSeen: new Date()
            };
            await db.collection('users').insertOne(newUser);
            socket.data.uid = uid; // socket 객체에 uid 저장
            socket.emit('registerResponse', { success: true, uid, username, nickname: newUser.nickname });
            console.log(`使用者已註冊: ${username} (UID: ${uid})`);
        } catch (error) {
            console.error("註冊錯誤:", error);
            socket.emit('registerResponse', { success: false, message: '註冊失敗: ' + error.message });
        }
    });

    // 사용자 로그인 이벤트
    socket.on('login', async (data) => {
        try {
            const { username, password, deviceInfo } = data;
            if (!username || !password) {
                socket.emit('loginResponse', { success: false, message: '用戶名和密碼為必填項' });
                return;
            }

            // 실제 환경에서는 비밀번호 해싱 및 비교 필요
            const user = await db.collection('users').findOne({ username, password });
            if (user) {
                await db.collection('users').updateOne(
                    { uid: user.uid },
                    { $set: { socketId: socket.id, online: true, deviceInfo: deviceInfo || user.deviceInfo, lastSeen: new Date() } }
                );
                socket.data.uid = user.uid; // socket 객체에 uid 저장
                socket.emit('loginResponse', {
                    success: true,
                    uid: user.uid,
                    username: user.username,
                    nickname: user.nickname
                });
                console.log(`使用者已登入: ${username} (UID: ${user.uid})`);
            } else {
                socket.emit('loginResponse', { success: false, message: '用戶名或密碼錯誤' });
            }
        } catch (error) {
            console.error("登入錯誤:", error);
            socket.emit('loginResponse', { success: false, message: '登入失敗: ' + error.message });
        }
    });

    // 닉네임 업데이트 이벤트
    socket.on('updateNickname', async (data) => {
        if (!socket.data.uid) {
            socket.emit('updateNicknameResponse', { success: false, message: '使用者未登入' });
            return;
        }
        try {
            const { newNickname } = data;
            if (!newNickname || newNickname.trim() === "") {
                socket.emit('updateNicknameResponse', { success: false, message: '暱稱不能為空' });
                return;
            }
            await db.collection('users').updateOne(
                { uid: socket.data.uid },
                { $set: { nickname: newNickname } }
            );
            socket.emit('updateNicknameResponse', { success: true, nickname: newNickname });
            console.log(`使用者 ${socket.data.uid} 已將暱稱更新為 ${newNickname}`);
        } catch (error) {
            console.error("更新暱稱錯誤:", error);
            socket.emit('updateNicknameResponse', { success: false, message: '更新暱稱失敗: ' + error.message });
        }
    });


    // 친구 요청 보내기
    socket.on('sendFriendRequest', async (data) => {
        if (!socket.data.uid) {
            socket.emit('friendRequestResponse', { success: false, message: '使用者未登入' });
            return;
        }
        try {
            const { toUid } = data;
            const fromUid = socket.data.uid;

            if (fromUid === toUid) {
                socket.emit('friendRequestResponse', { success: false, message: '無法將自己加為好友' });
                return;
            }

            const toUser = await db.collection('users').findOne({ uid: toUid });
            if (!toUser) {
                socket.emit('friendRequestResponse', { success: false, message: '目標使用者不存在' });
                return;
            }

            const fromUser = await db.collection('users').findOne({ uid: fromUid });

            // 이미 친구인지 확인
            if (fromUser.friends && fromUser.friends.includes(toUid)) {
                socket.emit('friendRequestResponse', { success: false, message: '此使用者已經是您的好友' });
                return;
            }

            // 기존 요청 확인 (양방향)
            const existingRequest = await db.collection('pendingFriendRequests').findOne({
                $or: [
                    { fromUid, toUid, status: 'pending' },
                    { fromUid: toUid, toUid: fromUid, status: 'pending' }
                ]
            });
            if (existingRequest) {
                socket.emit('friendRequestResponse', { success: false, message: '已存在待處理的好友請求' });
                return;
            }

            const request = {
                fromUid,
                toUid,
                fromNickname: fromUser.nickname,
                status: 'pending',
                createdAt: new Date()
            };
            await db.collection('pendingFriendRequests').insertOne(request);

            // 대상 사용자에게 실시간 알림
            if (toUser.online && toUser.socketId) {
                io.to(toUser.socketId).emit('newFriendRequest', {
                    fromUid,
                    fromNickname: fromUser.nickname,
                    requestId: request._id // 요청 ID도 함께 전달
                });
            }
            socket.emit('friendRequestResponse', { success: true, message: '好友請求已發送' });
        } catch (error) {
            console.error("傳送好友請求錯誤:", error);
            socket.emit('friendRequestResponse', { success: false, message: '傳送好友請求失敗: ' + error.message });
        }
    });

    // 친구 요청 수락
    socket.on('acceptFriendRequest', async (data) => {
        if (!socket.data.uid) {
            socket.emit('acceptFriendRequestResponse', { success: false, message: '使用者未登入' });
            return;
        }
        try {
            const { fromUid } = data; // 요청을 보낸 사람의 UID
            const toUid = socket.data.uid; // 현재 사용자 (요청을 받은 사람)

            const request = await db.collection('pendingFriendRequests').findOne({ fromUid, toUid, status: 'pending' });
            if (!request) {
                socket.emit('acceptFriendRequestResponse', { success: false, message: '找不到待處理的請求或請求已處理' });
                return;
            }

            // 친구 목록 업데이트
            await db.collection('users').updateOne({ uid: fromUid }, { $addToSet: { friends: toUid } });
            await db.collection('users').updateOne({ uid: toUid }, { $addToSet: { friends: fromUid } });

            // 요청 상태 업데이트 또는 삭제
            await db.collection('pendingFriendRequests').deleteOne({ _id: request._id });

            // 1:1 채팅방 생성 또는 기존 채팅방 찾기
            const members = [fromUid, toUid].sort(); // 항상 동일한 순서로 멤버 정렬
            let privateChat = await db.collection('privateChats').findOne({ members: members });

            if (!privateChat) {
                const newChatId = `private-${generateUid()}`;
                privateChat = {
                    chatId: newChatId,
                    type: 'private',
                    members: members,
                    createdAt: new Date(),
                    lastMessageAt: new Date()
                };
                await db.collection('privateChats').insertOne(privateChat);
                 // 메시지 컬렉션에 해당 채팅방 문서 생성
                await db.collection('messages').insertOne({ chatId: newChatId, messages: [] });
            }
            
            const fromUserDetails = await db.collection('users').findOne({ uid: fromUid }, { projection: { nickname: 1, online: 1 } });
            const toUserDetails = await db.collection('users').findOne({ uid: toUid }, { projection: { nickname: 1, online: 1 } });


            // 요청 보낸 사용자에게 알림
            const fromUserSocket = await db.collection('users').findOne({ uid: fromUid });
            if (fromUserSocket && fromUserSocket.online && fromUserSocket.socketId) {
                io.to(fromUserSocket.socketId).emit('friendRequestAcceptedNotification', {
                    acceptedByUid: toUid,
                    acceptedByNickname: toUserDetails.nickname,
                    chatId: privateChat.chatId
                });
            }

            // 요청 수락한 사용자에게 응답
            socket.emit('acceptFriendRequestResponse', { 
                success: true, 
                message: '好友請求已接受',
                friendUid: fromUid,
                friendNickname: fromUserDetails.nickname,
                chatId: privateChat.chatId
            });

        } catch (error) {
            console.error("接受好友請求錯誤:", error);
            socket.emit('acceptFriendRequestResponse', { success: false, message: '接受好友請求失敗: ' + error.message });
        }
    });

    // 친구 요청 거절
    socket.on('rejectFriendRequest', async (data) => {
        if (!socket.data.uid) {
            socket.emit('rejectFriendRequestResponse', { success: false, message: '使用者未登入' });
            return;
        }
        try {
            const { fromUid } = data; // 요청을 보낸 사람의 UID
            const toUid = socket.data.uid; // 현재 사용자

            const request = await db.collection('pendingFriendRequests').findOne({ fromUid, toUid, status: 'pending' });
            if (!request) {
                socket.emit('rejectFriendRequestResponse', { success: false, message: '找不到待處理的請求或請求已處理' });
                return;
            }

            // 요청 상태 업데이트 또는 삭제
            await db.collection('pendingFriendRequests').deleteOne({ _id: request._id });
            
            // 요청 보낸 사용자에게 알림 (선택 사항)
            const fromUserSocket = await db.collection('users').findOne({ uid: fromUid });
            if (fromUserSocket && fromUserSocket.online && fromUserSocket.socketId) {
                 io.to(fromUserSocket.socketId).emit('friendRequestRejectedNotification', {
                    rejectedByUid: toUid,
                });
            }

            socket.emit('rejectFriendRequestResponse', { success: true, message: '好友請求已拒絕' });
        } catch (error) {
            console.error("拒絕好友請求錯誤:", error);
            socket.emit('rejectFriendRequestResponse', { success: false, message: '拒絕好友請求失敗: ' + error.message });
        }
    });
    
    // 보류 중인 친구 요청 목록 가져오기
    socket.on('getPendingFriendRequests', async () => {
        if (!socket.data.uid) {
            socket.emit('getPendingFriendRequestsResponse', { success: false, message: '使用者未登入', requests: [] });
            return;
        }
        try {
            const requests = await db.collection('pendingFriendRequests').find({ toUid: socket.data.uid, status: 'pending' }).toArray();
            socket.emit('getPendingFriendRequestsResponse', { success: true, requests });
        } catch (error) {
            console.error("取得待處理的好友請求時發生錯誤:", error);
            socket.emit('getPendingFriendRequestsResponse', { success: false, message: '取得待處理的好友請求失敗', requests: [] });
        }
    });


    // 그룹 채팅 생성
    socket.on('createGroupChat', async (data) => {
        if (!socket.data.uid) {
            socket.emit('createGroupChatResponse', { success: false, message: '使用者未登入' });
            return;
        }
        try {
            const { groupName, memberUids, password } = data; // memberUids는 친구 목록에서 선택된 UID 배열
            const creatorUid = socket.data.uid;

            if (!groupName || groupName.trim() === "") {
                socket.emit('createGroupChatResponse', { success: false, message: '群組名稱不能為空' });
                return;
            }

            let allMemberUids = [creatorUid, ...(memberUids || [])];
            // 중복 제거
            allMemberUids = [...new Set(allMemberUids)];

            // 모든 멤버가 존재하는지 확인
            const memberDocs = await db.collection('users').find({ uid: { $in: allMemberUids } }).toArray();
            if (memberDocs.length !== allMemberUids.length) {
                 socket.emit('createGroupChatResponse', { success: false, message: '部分成員不存在' });
                 return;
            }

            const chatId = `group-${generateUid()}`;
            const newGroupChat = {
                chatId,
                name: groupName,
                type: 'group',
                adminUid: creatorUid,
                members: allMemberUids,
                password: password || null, // 비밀번호 (선택 사항, 해싱 필요)
                createdAt: new Date(),
                lastMessageAt: new Date()
            };
            await db.collection('groupChats').insertOne(newGroupChat);
            // 메시지 컬렉션에 해당 채팅방 문서 생성
            await db.collection('messages').insertOne({ chatId: chatId, messages: [] });


            // 모든 멤버에게 새 그룹 채팅 알림
            for (const memberUid of allMemberUids) {
                const member = memberDocs.find(m => m.uid === memberUid);
                if (member && member.online && member.socketId) {
                    io.to(member.socketId).emit('newGroupChatNotification', {
                        chatId,
                        groupName,
                        adminUid: creatorUid,
                        members: allMemberUids
                    });
                }
            }
            socket.emit('createGroupChatResponse', { success: true, chatId, groupName, members: allMemberUids });
        } catch (error) {
            console.error("建立群組聊天錯誤:", error);
            socket.emit('createGroupChatResponse', { success: false, message: '建立群組聊天失敗: ' + error.message });
        }
    });

    // 그룹 채팅에 사용자 초대 (관리자만)
    socket.on('inviteToGroupChat', async (data) => {
        if (!socket.data.uid) {
            socket.emit('inviteToGroupChatResponse', { success: false, message: '使用者未登入' });
            return;
        }
        try {
            const { chatId, inviteeUid } = data;
            const inviterUid = socket.data.uid;

            const groupChat = await db.collection('groupChats').findOne({ chatId });
            if (!groupChat) {
                socket.emit('inviteToGroupChatResponse', { success: false, message: '群組聊天不存在' });
                return;
            }
            if (groupChat.adminUid !== inviterUid) {
                socket.emit('inviteToGroupChatResponse', { success: false, message: '只有管理員可以邀請成員' });
                return;
            }
            if (groupChat.members.includes(inviteeUid)) {
                socket.emit('inviteToGroupChatResponse', { success: false, message: '使用者已經是該群組的成員' });
                return;
            }
            const inviteeUser = await db.collection('users').findOne({ uid: inviteeUid });
            if (!inviteeUser) {
                socket.emit('inviteToGroupChatResponse', { success: false, message: '受邀使用者不存在' });
                return;
            }

            // 여기서 실제 초대 로직 (예: pendingGroupInvites 컬렉션 사용 또는 직접 알림)
            // 간단하게 바로 멤버 추가 후 알림으로 구현
            await db.collection('groupChats').updateOne({ chatId }, { $addToSet: { members: inviteeUid } });
            
            const inviterUser = await db.collection('users').findOne({uid: inviterUid});

            // 초대된 사용자에게 알림
            if (inviteeUser.online && inviteeUser.socketId) {
                io.to(inviteeUser.socketId).emit('groupInviteNotification', {
                    chatId,
                    groupName: groupChat.name,
                    invitedByNickname: inviterUser.nickname
                });
            }
            
            // 그룹 멤버들에게 새 멤버 알림 (시스템 메시지)
            const systemMessage = {
                messageId: generateUid(),
                chatId,
                fromUid: 'system',
                nicknameAtTimeOfMessage: '系統',
                text: `${inviteeUser.nickname} 已加入群組。`,
                timestamp: new Date(),
                type: 'system'
            };
            await db.collection('messages').updateOne({ chatId }, { $push: { messages: systemMessage }, $set: {lastMessageAt: new Date()} });

            groupChat.members.forEach(async memberUid => {
                if(memberUid === inviteeUid) return; // 방금 추가된 멤버는 제외
                const member = await db.collection('users').findOne({ uid: memberUid });
                if (member && member.online && member.socketId) {
                    io.to(member.socketId).emit('message', systemMessage); // 기존 멤버들에게 시스템 메시지 전송
                    io.to(member.socketId).emit('groupMemberAdded', {chatId, newMemberUid: inviteeUid, newMemberNickname: inviteeUser.nickname}); // 멤버 추가 이벤트
                }
            });


            socket.emit('inviteToGroupChatResponse', { success: true, message: `${inviteeUser.nickname} 已被邀請至群組。` });

        } catch (error) {
            console.error("邀請至群組聊天錯誤:", error);
            socket.emit('inviteToGroupChatResponse', { success: false, message: '邀請失敗: ' + error.message });
        }
    });


    // 그룹 채팅 나가기
    socket.on('leaveGroup', async (data) => {
        if (!socket.data.uid) {
            socket.emit('leaveGroupResponse', { success: false, message: '使用者未登入' });
            return;
        }
        try {
            const { chatId } = data;
            const leaverUid = socket.data.uid;

            const groupChat = await db.collection('groupChats').findOne({ chatId });
            if (!groupChat) {
                socket.emit('leaveGroupResponse', { success: false, message: '群組聊天不存在' });
                return;
            }
            if (!groupChat.members.includes(leaverUid)) {
                socket.emit('leaveGroupResponse', { success: false, message: '您不是此群組的成員' });
                return;
            }

            await db.collection('groupChats').updateOne({ chatId }, { $pull: { members: leaverUid } });
            const updatedGroupChat = await db.collection('groupChats').findOne({ chatId });
            const leaverUser = await db.collection('users').findOne({uid: leaverUid});

            // 관리자가 나갔고, 남은 멤버가 있다면 새 관리자 지정
            if (groupChat.adminUid === leaverUid && updatedGroupChat.members.length > 0) {
                const newAdminUid = updatedGroupChat.members[0]; // 첫 번째 멤버를 새 관리자로
                await db.collection('groupChats').updateOne({ chatId }, { $set: { adminUid: newAdminUid } });
                 // 시스템 메시지: 관리자 변경
                const adminChangeMessage = {
                    messageId: generateUid(),
                    chatId,
                    fromUid: 'system',
                    nicknameAtTimeOfMessage: '系統',
                    text: `${leaverUser.nickname} 已離開群組。 ${newAdminUid} 已成為新的管理員。`,
                    timestamp: new Date(),
                    type: 'system'
                };
                await db.collection('messages').updateOne({ chatId }, { $push: { messages: adminChangeMessage }, $set: {lastMessageAt: new Date()} });
                 updatedGroupChat.members.forEach(async memberUid => {
                    const member = await db.collection('users').findOne({ uid: memberUid });
                    if (member && member.online && member.socketId) {
                        io.to(member.socketId).emit('message', adminChangeMessage);
                        io.to(member.socketId).emit('groupAdminChanged', {chatId, newAdminUid});
                    }
                });

            } else if (updatedGroupChat.members.length === 0) {
                // 마지막 멤버가 나가면 그룹 삭제 또는 비활성화 (여기서는 메시지만 남김)
                const leaveMessage = {
                    messageId: generateUid(),
                    chatId,
                    fromUid: 'system',
                    nicknameAtTimeOfMessage: '系統',
                    text: `${leaverUser.nickname} 已離開群組。群組已空。`,
                    timestamp: new Date(),
                    type: 'system'
                };
                 await db.collection('messages').updateOne({ chatId }, { $push: { messages: leaveMessage }, $set: {lastMessageAt: new Date()} });
                // await db.collection('groupChats').deleteOne({ chatId }); // 그룹 자체를 삭제할 수도 있음
                // await db.collection('messages').deleteMany({ chatId }); // 관련 메시지 삭제
            } else {
                 // 일반 멤버가 나갈 때 시스템 메시지
                const leaveMessage = {
                    messageId: generateUid(),
                    chatId,
                    fromUid: 'system',
                    nicknameAtTimeOfMessage: '系統',
                    text: `${leaverUser.nickname} 已離開群組。`,
                    timestamp: new Date(),
                    type: 'system'
                };
                await db.collection('messages').updateOne({ chatId }, { $push: { messages: leaveMessage }, $set: {lastMessageAt: new Date()} });
                updatedGroupChat.members.forEach(async memberUid => {
                    const member = await db.collection('users').findOne({ uid: memberUid });
                    if (member && member.online && member.socketId) {
                        io.to(member.socketId).emit('message', leaveMessage);
                        io.to(member.socketId).emit('groupMemberLeft', {chatId, leftMemberUid: leaverUid});
                    }
                });
            }
            socket.emit('leaveGroupResponse', { success: true, message: '已成功離開群組' });

        } catch (error) {
            console.error("離開群組聊天錯誤:", error);
            socket.emit('leaveGroupResponse', { success: false, message: '離開群組失敗: ' + error.message });
        }
    });


    // 메시지 전송 (1:1 및 그룹 공통 핸들러)
    socket.on('sendMessage', async (data) => {
        if (!socket.data.uid) {
            socket.emit('messageResponse', { success: false, message: '使用者未登入' });
            return;
        }
        try {
            const { chatId, text } = data;
            const fromUid = socket.data.uid;

            if (!chatId || !text || text.trim() === "") {
                socket.emit('messageResponse', { success: false, message: '聊天 ID 和訊息內容不能為空' });
                return;
            }

            const fromUser = await db.collection('users').findOne({ uid: fromUid });
            if (!fromUser) { // 이럴 경우는 거의 없지만 방어 코드
                socket.emit('messageResponse', { success: false, message: '發送者不存在' });
                return;
            }

            let chat;
            let chatType;

            // 채팅방 유형 확인 (privateChats 또는 groupChats에서 찾기)
            chat = await db.collection('privateChats').findOne({ chatId });
            if (chat) {
                chatType = 'private';
            } else {
                chat = await db.collection('groupChats').findOne({ chatId });
                if (chat) {
                    chatType = 'group';
                }
            }

            if (!chat) {
                socket.emit('messageResponse', { success: false, message: '聊天不存在' });
                return;
            }

            if (!chat.members.includes(fromUid)) {
                socket.emit('messageResponse', { success: false, message: '您不是此聊天的成員' });
                return;
            }

            const message = {
                messageId: generateUid(),
                chatId,
                fromUid,
                nicknameAtTimeOfMessage: fromUser.nickname, // 메시지 보낼 당시의 닉네임 저장
                text,
                timestamp: new Date(),
                type: 'text' // 'image', 'file' 등 확장 가능
            };

            await db.collection('messages').updateOne(
                { chatId },
                { $push: { messages: message }, $set: { lastMessageAt: message.timestamp } },
                { upsert: true } // chatId에 해당하는 문서가 없으면 생성
            );
            
            // 해당 채팅방의 모든 멤버에게 메시지 전송
            for (const memberUid of chat.members) {
                const memberUser = await db.collection('users').findOne({ uid: memberUid });
                if (memberUser && memberUser.online && memberUser.socketId) {
                    io.to(memberUser.socketId).emit('message', message);
                }
            }
            // 메시지 발신자에게 성공 응답 (선택 사항)
            socket.emit('messageResponse', { success: true, messageSent: message });

        } catch (error) {
            console.error("傳送訊息錯誤:", error);
            socket.emit('messageResponse', { success: false, message: '傳送訊息失敗: ' + error.message });
        }
    });

    // 채팅 기록 가져오기
    socket.on('getChatHistory', async (data) => {
        if (!socket.data.uid) {
            socket.emit('getChatHistoryResponse', { success: false, message: '使用者未登入', messages: [] });
            return;
        }
        try {
            const { chatId, limit = 50, beforeTimestamp } = data; // 페이징을 위한 limit, beforeTimestamp 추가
            
            let query = { chatId };
            if (beforeTimestamp) {
                query['messages.timestamp'] = { $lt: new Date(beforeTimestamp) };
            }

            const messageDoc = await db.collection('messages').findOne({ chatId });

            if (!messageDoc) {
                 socket.emit('getChatHistoryResponse', { success: true, messages: [], hasMore: false });
                 return;
            }

            // 사용자가 해당 채팅의 멤버인지 확인 (보안 강화)
            const privateChat = await db.collection('privateChats').findOne({ chatId, members: socket.data.uid });
            const groupChat = await db.collection('groupChats').findOne({ chatId, members: socket.data.uid });

            if (!privateChat && !groupChat) {
                socket.emit('getChatHistoryResponse', { success: false, message: '您無權存取此聊天記錄', messages: [] });
                return;
            }
            
            let messages = messageDoc.messages || [];
            
            // 시간순 정렬 (최신 메시지가 배열의 끝으로 가도록)
            messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            let paginatedMessages = messages;
            if (beforeTimestamp) {
                paginatedMessages = messages.filter(m => new Date(m.timestamp) < new Date(beforeTimestamp));
            }
            
            const startIndex = Math.max(0, paginatedMessages.length - limit);
            const resultMessages = paginatedMessages.slice(startIndex);
            const hasMore = startIndex > 0;


            socket.emit('getChatHistoryResponse', { success: true, messages: resultMessages, hasMore });

        } catch (error) {
            console.error("取得聊天記錄錯誤:", error);
            socket.emit('getChatHistoryResponse', { success: false, message: '取得聊天記錄失敗: ' + error.message, messages: [] });
        }
    });

    // 채팅 목록 가져오기 (1:1 및 그룹)
    socket.on('getChatList', async () => {
        if (!socket.data.uid) {
            socket.emit('getChatListResponse', { success: false, message: '使用者未登入', chats: [] });
            return;
        }
        try {
            const currentUserUid = socket.data.uid;
            const privateChats = await db.collection('privateChats').find({ members: currentUserUid }).toArray();
            const groupChats = await db.collection('groupChats').find({ members: currentUserUid }).toArray();

            let chatList = [];

            for (const pChat of privateChats) {
                const otherMemberUid = pChat.members.find(uid => uid !== currentUserUid);
                const otherUser = await db.collection('users').findOne({ uid: otherMemberUid }, { projection: { nickname: 1, online: 1 } });
                const messageDoc = await db.collection('messages').findOne({ chatId: pChat.chatId });
                const lastMsg = messageDoc && messageDoc.messages.length > 0 ? messageDoc.messages[messageDoc.messages.length - 1] : null;

                chatList.push({
                    chatId: pChat.chatId,
                    type: 'private',
                    name: otherUser ? otherUser.nickname : '未知使用者',
                    otherMemberUid: otherMemberUid,
                    otherMemberOnline: otherUser ? otherUser.online : false,
                    lastMessage: lastMsg ? lastMsg.text : '尚無訊息',
                    lastMessageTimestamp: lastMsg ? lastMsg.timestamp : pChat.lastMessageAt,
                    unreadCount: 0 // TODO: 읽지 않은 메시지 수 계산 로직 추가
                });
            }

            for (const gChat of groupChats) {
                const messageDoc = await db.collection('messages').findOne({ chatId: gChat.chatId });
                const lastMsg = messageDoc && messageDoc.messages.length > 0 ? messageDoc.messages[messageDoc.messages.length - 1] : null;

                chatList.push({
                    chatId: gChat.chatId,
                    type: 'group',
                    name: gChat.name,
                    adminUid: gChat.adminUid,
                    memberCount: gChat.members.length,
                    lastMessage: lastMsg ? lastMsg.text : '尚無訊息',
                    lastMessageTimestamp: lastMsg ? lastMsg.timestamp : gChat.lastMessageAt,
                    unreadCount: 0 // TODO: 읽지 않은 메시지 수 계산 로직 추가
                });
            }

            // 최근 메시지 시간으로 정렬 (내림차순)
            chatList.sort((a, b) => new Date(b.lastMessageTimestamp) - new Date(a.lastMessageTimestamp));

            socket.emit('getChatListResponse', { success: true, chats: chatList });

        } catch (error) {
            console.error("取得聊天清單錯誤:", error);
            socket.emit('getChatListResponse', { success: false, message: '取得聊天清單失敗: ' + error.message, chats: [] });
        }
    });

    // 사용자의 친구 목록 가져오기
    socket.on('getFriendList', async () => {
        if (!socket.data.uid) {
            socket.emit('getFriendListResponse', { success: false, message: '使用者未登入', friends: [] });
            return;
        }
        try {
            const user = await db.collection('users').findOne({ uid: socket.data.uid });
            if (!user || !user.friends) {
                socket.emit('getFriendListResponse', { success: true, friends: [] });
                return;
            }
            const friendDetails = await db.collection('users').find({ uid: { $in: user.friends } })
                                          .project({ uid: 1, nickname: 1, online: 1, lastSeen: 1 }).toArray();
            socket.emit('getFriendListResponse', { success: true, friends: friendDetails });
        } catch (error) {
            console.error("取得好友清單錯誤:", error);
            socket.emit('getFriendListResponse', { success: false, message: '取得好友清單失敗', friends: [] });
        }
    });


    // Keep-alive ping (클라이언트에서 주기적으로 보내는 이벤트)
    socket.on('keepAlive', () => {
        // console.log(`Keep-alive ping from ${socket.id}`);
        socket.emit('keepAliveResponse', { timestamp: new Date() });
    });

});

// 예기치 않은 오류 처리
process.on('uncaughtException', (error) => {
    console.error('未捕獲的例外:', error);
    // 프로덕션 환경에서는 오류 로깅 후 정상적으로 프로세스 종료 또는 재시작 고려
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('未處理的 Promise 拒絕:', reason);
});
