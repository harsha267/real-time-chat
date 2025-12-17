require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Message = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Serve static files (HTML, CSS, JS)
app.use(express.static("public"));

// Map username to socket ID for efficient message routing
const userSocketMap = new Map(); // username -> socketId
const socketUserMap = new Map(); // socketId -> username

// Group/Room management
const rooms = new Map(); // roomName -> Set of socketIds
const userRooms = new Map(); // socketId -> Set of roomNames
const groupIds = new Map(); // groupName -> groupId (unique identifier)
const groupMembers = new Map(); // groupId -> Set of usernames

// Message tracking for delivery and read status
const messageStatus = new Map(); // messageId -> { from, groupId/to, status: 'sent'|'delivered'|'read', deliveredTo: Set, readBy: Set, chatType }

/**
 * Socket.IO Event Handlers
 */

io.on("connection", (socket) => {
  console.log(`🟢 Client connected: ${socket.id}`);

  /**
   * User Registration
   * Event: 'register'
   * Data: { username: string }
   * 
   * Maps username to socket ID and broadcasts online status
   */
  socket.on("register", (data) => {
    const { username } = data;

    if (!username || username.trim() === "") {
      socket.emit("error", { message: "Username is required" });
      return;
    }

    // Check if username is already taken
    if (userSocketMap.has(username)) {
      socket.emit("error", { message: "Username already taken" });
      return;
    }

    // Map username to socket ID
    userSocketMap.set(username, socket.id);
    socketUserMap.set(socket.id, username);
    socket.username = username;

    console.log(`✅ User registered: ${username} (${socket.id})`);

    // Notify the user of successful registration
    socket.emit("registered", {
      username,
      message: "Successfully registered"
    });

    // Broadcast updated user list to all clients
    broadcastUserList();

    // Broadcast online status
    io.emit("userStatus", {
      username,
      status: "online"
    });
  });

  /**
   * Send Private Message
   * Event: 'privateMessage'
   * Data: { to: string, text: string }
   * 
   * Delivers message only to the specified receiver
   */
  socket.on("privateMessage", async (data) => {
    const { to, text } = data;
    const from = socket.username;

    if (!from) {
      socket.emit("error", { message: "Please register first" });
      return;
    }

    if (!to || !text) {
      socket.emit("error", { message: "Recipient and message text are required" });
      return;
    }

    // Get receiver's socket ID
    const receiverSocketId = userSocketMap.get(to);

    if (!receiverSocketId) {
      socket.emit("error", { message: `User ${to} is not online` });
      return;
    }

    // Generate unique message ID
    const messageId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const messageData = {
      id: messageId,
      from,
      to,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      status: "sent"
    };

    console.log(`📨 Private message from ${from} to ${to}: ${text}`);

    // Save to database with status "sent"
    try {
      await Message.create({
        messageId,
        from,
        to,
        chatType: "private",
        text: text.trim(),
        status: "sent"
      });
      console.log(`💾 Message ${messageId} saved to DB with status: sent`);
    } catch (dbErr) {
      console.error("⚠️ Database error:", dbErr.message);
      socket.emit("error", { message: "Failed to save message" });
      return;
    }

    // Track message status in memory
    messageStatus.set(messageId, {
      from,
      to,
      status: "sent",
      chatType: "private",
      deliveredAt: null,
      readAt: null
    });

    // Send message to receiver using io.to(socketId)
    io.to(receiverSocketId).emit("privateMessage", messageData);

    // Send confirmation to sender
    socket.emit("messageSent", {
      to,
      message: messageData
    });
    
    // NOTE: Do NOT mark as delivered here - wait for client to emit message_delivered
  });

  /**
   * Get Online Users
   * Event: 'getUsers'
   * 
   * Returns list of all online users
   */
  socket.on("getUsers", () => {
    const users = Array.from(userSocketMap.keys());
    socket.emit("userList", { users });
  });

  /**
   * Create or Join Group
   * Event: 'joinGroup'
   * Data: { groupName: string }
   * 
   * Creates a new group or joins an existing one
   */
  socket.on("joinGroup", (data) => {
    const { groupName } = data;
    const username = socket.username;

    if (!username) {
      socket.emit("error", { message: "Please register first" });
      return;
    }

    if (!groupName || groupName.trim() === "") {
      socket.emit("error", { message: "Group name is required" });
        return;
      }

    const roomName = groupName.trim();

    // Initialize room if it doesn't exist
    let groupId;
    if (!rooms.has(roomName)) {
      rooms.set(roomName, new Set());
      // Generate unique groupId
      groupId = `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      groupIds.set(roomName, groupId);
      groupMembers.set(groupId, new Set());
      console.log(`📦 Group created: ${roomName} (ID: ${groupId})`);
    } else {
      groupId = groupIds.get(roomName);
    }

    // Add socket to room
    rooms.get(roomName).add(socket.id);

    // Track user's rooms
    if (!userRooms.has(socket.id)) {
      userRooms.set(socket.id, new Set());
    }
    userRooms.get(socket.id).add(roomName);

    // Add user to group members
    if (groupId && groupMembers.has(groupId)) {
      groupMembers.get(groupId).add(username);
    }

    // Join Socket.IO room using groupId (primary) and roomName (for compatibility)
    socket.join(groupId);
    socket.join(roomName);

    console.log(`✅ ${username} joined group: ${roomName} (ID: ${groupId})`);

    // Get list of members
    const members = Array.from(rooms.get(roomName))
      .map(socketId => socketUserMap.get(socketId))
      .filter(Boolean);

    // Notify user
    socket.emit("groupJoined", {
      groupName: roomName,
      groupId: groupId,
      members
    });

    // Notify others in the group
    socket.to(groupId).emit("userJoinedGroup", {
      groupName: roomName,
      groupId: groupId,
      username,
      members
    });

    // Broadcast updated group list
    broadcastGroupList();
  });

  /**
   * Leave Group
   * Event: 'leaveGroup'
   * Data: { groupName: string }
   */
  socket.on("leaveGroup", (data) => {
    const { groupName } = data;
    const username = socket.username;

    if (!username || !groupName) {
      return;
    }

    const roomName = groupName.trim();
    const groupId = groupIds.get(roomName);

    if (rooms.has(roomName)) {
      rooms.get(roomName).delete(socket.id);
      
      // Remove from user's room list
      if (userRooms.has(socket.id)) {
        userRooms.get(socket.id).delete(roomName);
      }

      // Remove from group members
      if (groupId && groupMembers.has(groupId)) {
        groupMembers.get(groupId).delete(username);
      }

      // Leave Socket.IO room
      const groupId = groupIds.get(roomName);
      if (groupId) {
        socket.leave(groupId);
      }
      socket.leave(roomName);

      console.log(`👋 ${username} left group: ${roomName}`);

      // If room is empty, remove it
      if (rooms.get(roomName).size === 0) {
        rooms.delete(roomName);
        if (groupId) {
          groupIds.delete(roomName);
          groupMembers.delete(groupId);
        }
        console.log(`🗑️ Group deleted: ${roomName}`);
      } else {
        // Notify others in the group
        const groupId = groupIds.get(roomName);
        if (groupId) {
          socket.to(groupId).emit("userLeftGroup", {
            groupName: roomName,
            groupId: groupId,
            username
          });
        }
      }

      socket.emit("groupLeft", { groupName: roomName });
      broadcastGroupList();
    }
  });

  /**
   * Add User to Group
   * Event: 'addUserToGroup'
   * Data: { groupName: string, username: string }
   */
  socket.on("addUserToGroup", (data) => {
    const { groupName, username: targetUsername } = data;
    const requester = socket.username;

    if (!requester || !groupName || !targetUsername) {
      socket.emit("error", { message: "Missing required fields" });
      return;
    }

    const roomName = groupName.trim();
    const groupId = groupIds.get(roomName);

    // Check if group exists
    if (!rooms.has(roomName) || !groupId) {
      socket.emit("error", { message: "Group does not exist" });
      return;
    }

    // Check if requester is in the group
    if (!rooms.get(roomName).has(socket.id)) {
      socket.emit("error", { message: "You are not a member of this group" });
      return;
    }

    // Check if target user exists and is online
    const targetSocketId = userSocketMap.get(targetUsername);
    if (!targetSocketId) {
      socket.emit("error", { message: `User ${targetUsername} is not online` });
      return;
    }

    // Check if user is already in group
    if (rooms.get(roomName).has(targetSocketId)) {
      socket.emit("error", { message: `User ${targetUsername} is already in the group` });
      return;
    }

    // Add user to group
    rooms.get(roomName).add(targetSocketId);
    if (!userRooms.has(targetSocketId)) {
      userRooms.set(targetSocketId, new Set());
    }
    userRooms.get(targetSocketId).add(roomName);
    groupMembers.get(groupId).add(targetUsername);

    // Join Socket.IO room using groupId
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket && groupId) {
      targetSocket.join(groupId);
      targetSocket.join(roomName); // Also join by name
    }

    console.log(`➕ ${requester} added ${targetUsername} to group: ${roomName}`);

    // Get updated members list
    const members = Array.from(rooms.get(roomName))
      .map(socketId => socketUserMap.get(socketId))
      .filter(Boolean);

    // Notify all group members using groupId
    io.to(groupId).emit("userAddedToGroup", {
      groupName: roomName,
      groupId: groupId,
      addedBy: requester,
      addedUser: targetUsername,
      members
    });

    broadcastGroupList();
  });

  /**
   * Remove User from Group
   * Event: 'removeUserFromGroup'
   * Data: { groupName: string, username: string }
   */
  socket.on("removeUserFromGroup", (data) => {
    const { groupName, username: targetUsername } = data;
    const requester = socket.username;

    if (!requester || !groupName || !targetUsername) {
      socket.emit("error", { message: "Missing required fields" });
      return;
    }

    const roomName = groupName.trim();
    const groupId = groupIds.get(roomName);

    // Check if group exists
    if (!rooms.has(roomName) || !groupId) {
      socket.emit("error", { message: "Group does not exist" });
      return;
    }

    // Check if requester is in the group
    if (!rooms.get(roomName).has(socket.id)) {
      socket.emit("error", { message: "You are not a member of this group" });
      return;
    }

    // Check if target user is in group
    const targetSocketId = userSocketMap.get(targetUsername);
    if (!targetSocketId || !rooms.get(roomName).has(targetSocketId)) {
      socket.emit("error", { message: `User ${targetUsername} is not in this group` });
        return;
      }

    // Remove user from group
    rooms.get(roomName).delete(targetSocketId);
    if (userRooms.has(targetSocketId)) {
      userRooms.get(targetSocketId).delete(roomName);
    }
    if (groupMembers.has(groupId)) {
      groupMembers.get(groupId).delete(targetUsername);
    }

    // Leave Socket.IO room
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket && groupId) {
      targetSocket.leave(groupId);
      targetSocket.leave(roomName);
    }

    console.log(`➖ ${requester} removed ${targetUsername} from group: ${roomName}`);

    // Get updated members list
    const members = Array.from(rooms.get(roomName))
      .map(socketId => socketUserMap.get(socketId))
      .filter(Boolean);

    // Notify all group members using groupId
    io.to(groupId).emit("userRemovedFromGroup", {
      groupName: roomName,
      groupId: groupId,
      removedBy: requester,
      removedUser: targetUsername,
      members
    });

    // Notify removed user
    if (targetSocket) {
      targetSocket.emit("removedFromGroup", {
        groupName: roomName,
        groupId: groupId
      });
    }

    broadcastGroupList();
  });

  /**
   * Get Groups
   * Event: 'getGroups'
   * 
   * Returns list of all available groups
   */
  socket.on("getGroups", () => {
    const groups = Array.from(rooms.keys()).map(groupName => {
      const groupId = groupIds.get(groupName);
      const members = Array.from(rooms.get(groupName))
        .map(socketId => socketUserMap.get(socketId))
        .filter(Boolean);
      return {
        name: groupName,
        groupId: groupId,
        memberCount: members.length,
        members
      };
    });
    socket.emit("groupList", { groups });
  });

  /**
   * Get User's Groups
   * Event: 'getMyGroups'
   * 
   * Returns list of groups the user is in
   */
  socket.on("getMyGroups", () => {
    const myGroups = userRooms.get(socket.id) 
      ? Array.from(userRooms.get(socket.id))
      : [];
    socket.emit("myGroups", { groups: myGroups });
  });

  /**
   * Send Group Message
   * Event: 'groupMessage'
   * Data: { groupName: string, text: string }
   * 
   * Broadcasts message to all members of the group
   */
  socket.on("groupMessage", async (data) => {
    const { groupName, text } = data;
    const from = socket.username;

    if (!from) {
      socket.emit("error", { message: "Please register first" });
      return;
    }

    if (!groupName || !text) {
      socket.emit("error", { message: "Group name and message text are required" });
      return;
    }

    const roomName = groupName.trim();

    // Check if user is in the group
    if (!rooms.has(roomName) || !rooms.get(roomName).has(socket.id)) {
      socket.emit("error", { message: `You are not a member of group ${roomName}` });
        return;
      }

    // Generate unique message ID
    const messageId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const groupId = groupIds.get(roomName);
    
    // Get all group members
    const groupMemberSockets = Array.from(rooms.get(roomName));
    const totalMembers = groupMemberSockets.length;
    
    const messageData = {
      id: messageId,
      from,
      groupName: roomName,
      groupId: groupId,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      type: "group",
      status: "sent",
      totalMembers: totalMembers
    };

    console.log(`📢 Group message from ${from} to ${roomName} (${groupId}): ${text}`);

    // Save to database with status "sent"
    try {
      await Message.create({
        messageId,
        from,
        groupId: groupId,
        groupName: roomName,
        chatType: "group",
        text: text.trim(),
        status: "sent",
        deliveredTo: [],
        readBy: []
      });
      console.log(`💾 Group message ${messageId} saved to DB with status: sent`);
    } catch (dbErr) {
      console.error("⚠️ Database error:", dbErr.message);
      socket.emit("error", { message: "Failed to save message" });
      return;
    }

    // Track message status in memory
    messageStatus.set(messageId, {
      from,
      groupId: groupId,
      groupName: roomName,
      status: "sent",
      chatType: "group",
      deliveredTo: new Set(),
      readBy: new Set(),
      totalMembers: totalMembers,
      deliveredAt: null
    });

    // Broadcast to all members using io.to(groupId)
    io.to(groupId).emit("groupMessage", messageData);
    
    // NOTE: Do NOT mark as delivered here - wait for clients to emit message_delivered
  });

  /**
   * Message Delivered
   * Event: 'message_delivered'
   * Data: { messageId: string, from: string }
   * 
   * Client confirms message was received
   * Updates database and notifies sender
   */
  socket.on("message_delivered", async (data) => {
    const { messageId, from } = data;
    const receiver = socket.username;

    if (!receiver) {
      console.log("⚠️ message_delivered: receiver not registered");
      return;
    }

    if (!messageId || !from) {
      console.log("⚠️ message_delivered: missing messageId or from");
      return;
    }

    // Get message from database
    let messageDoc;
    try {
      messageDoc = await Message.findOne({ messageId });
      if (!messageDoc) {
        console.log(`⚠️ message_delivered: message ${messageId} not found in DB`);
        return;
      }
    } catch (dbErr) {
      console.error("⚠️ Database error:", dbErr.message);
      return;
    }

    // Verify receiver is the correct recipient
    if (messageDoc.chatType === "private") {
      if (messageDoc.to !== receiver || messageDoc.from !== from) {
        console.log(`⚠️ message_delivered: ${receiver} is not the recipient`);
        return;
      }
    } else if (messageDoc.chatType === "group") {
      // For groups, verify user is a member
      const groupId = messageDoc.groupId;
      if (!groupMembers.has(groupId) || !groupMembers.get(groupId).has(receiver)) {
        console.log(`⚠️ message_delivered: ${receiver} is not a member of group ${groupId}`);
        return;
      }
    }

    // Update database
    const deliveredAt = new Date();
    try {
      if (messageDoc.chatType === "private") {
        await Message.updateOne(
          { messageId },
          { 
            $set: { 
              status: "delivered",
              deliveredAt: deliveredAt
            }
          }
        );
        console.log(`💾 Message ${messageId} updated to DELIVERED in DB`);
      } else if (messageDoc.chatType === "group") {
        // Add receiver to deliveredTo array if not already there
        if (!messageDoc.deliveredTo.includes(receiver)) {
          await Message.updateOne(
            { messageId },
            { 
              $set: { status: "delivered" },
              $addToSet: { deliveredTo: receiver }
            }
          );
          console.log(`💾 Group message ${messageId} - ${receiver} marked as delivered`);
        }
      }
    } catch (dbErr) {
      console.error("⚠️ Database update error:", dbErr.message);
      return;
    }

    // Update in-memory status
    const messageInfo = messageStatus.get(messageId);
    if (messageInfo) {
      if (messageInfo.chatType === "private") {
        messageInfo.status = "delivered";
        messageInfo.deliveredAt = deliveredAt.toISOString();
      } else if (messageInfo.chatType === "group") {
        messageInfo.deliveredTo.add(receiver);
        messageInfo.status = "delivered";
        if (!messageInfo.deliveredAt) {
          messageInfo.deliveredAt = deliveredAt.toISOString();
        }
      }
    }

    // Notify sender
    const senderSocketId = userSocketMap.get(from);
    if (senderSocketId) {
      if (messageDoc.chatType === "private") {
        io.to(senderSocketId).emit("messageDelivered", {
          messageId,
          to: receiver,
          status: "delivered",
          deliveredAt: deliveredAt.toISOString()
        });
      } else if (messageDoc.chatType === "group") {
        // Get updated delivered count
        const updatedDoc = await Message.findOne({ messageId });
        io.to(senderSocketId).emit("messageDelivered", {
          messageId,
          groupId: messageDoc.groupId,
          deliveredTo: updatedDoc.deliveredTo.length,
          totalMembers: messageInfo ? messageInfo.totalMembers : 1,
          status: "delivered"
        });
      }
      console.log(`✅ Notified sender ${from} that message was delivered`);
    }
  });

  /**
   * Message Read
   * Event: 'message_read'
   * Data: { messageId: string, from: string }
   * 
   * Client confirms message was read
   * Updates database and notifies sender
   */
  socket.on("message_read", async (data) => {
    const { messageId, from } = data;
    const reader = socket.username;

    if (!reader) {
      console.log("⚠️ message_read: reader not registered");
      return;
    }

    if (!messageId || !from) {
      console.log("⚠️ message_read: missing messageId or from");
      return;
    }

    // Get message from database
    let messageDoc;
    try {
      messageDoc = await Message.findOne({ messageId });
      if (!messageDoc) {
        console.log(`⚠️ message_read: message ${messageId} not found in DB`);
        return;
      }
    } catch (dbErr) {
      console.error("⚠️ Database error:", dbErr.message);
      return;
    }

    // Verify reader is the correct recipient
    if (messageDoc.chatType === "private") {
      if (messageDoc.to !== reader || messageDoc.from !== from) {
        console.log(`⚠️ message_read: ${reader} is not the recipient`);
        return;
      }
    } else if (messageDoc.chatType === "group") {
      // For groups, verify user is a member
      const groupId = messageDoc.groupId;
      if (!groupMembers.has(groupId) || !groupMembers.get(groupId).has(reader)) {
        console.log(`⚠️ message_read: ${reader} is not a member of group ${groupId}`);
        return;
      }
    }

    // Update database
    const readAt = new Date();
    try {
      if (messageDoc.chatType === "private") {
        await Message.updateOne(
          { messageId },
          { 
            $set: { 
              status: "read",
              readAt: readAt
            }
          }
        );
        console.log(`💾 Message ${messageId} updated to READ in DB`);
      } else if (messageDoc.chatType === "group") {
        // Add reader to readBy array if not already there
        if (!messageDoc.readBy.includes(reader)) {
          await Message.updateOne(
            { messageId },
            { 
              $addToSet: { readBy: reader }
            }
          );
          
          // Check if all members have read
          const updatedDoc = await Message.findOne({ messageId });
          const messageInfo = messageStatus.get(messageId);
          const totalMembers = messageInfo ? messageInfo.totalMembers : updatedDoc.readBy.length;
          
          if (updatedDoc.readBy.length === totalMembers) {
            await Message.updateOne(
              { messageId },
              { $set: { status: "read", readAt: readAt } }
            );
          }
          
          console.log(`💾 Group message ${messageId} - ${reader} marked as read (${updatedDoc.readBy.length}/${totalMembers})`);
        }
      }
    } catch (dbErr) {
      console.error("⚠️ Database update error:", dbErr.message);
      return;
    }

    // Update in-memory status
    const messageInfo = messageStatus.get(messageId);
    if (messageInfo) {
      if (messageInfo.chatType === "private") {
        messageInfo.status = "read";
        messageInfo.readAt = readAt.toISOString();
      } else if (messageInfo.chatType === "group") {
        messageInfo.readBy.add(reader);
        if (messageInfo.readBy.size === messageInfo.totalMembers) {
          messageInfo.status = "read";
          messageInfo.readAt = readAt.toISOString();
        }
      }
    }

    // Notify sender
    const senderSocketId = userSocketMap.get(from);
    if (senderSocketId) {
      if (messageDoc.chatType === "private") {
        io.to(senderSocketId).emit("messageRead", {
          messageId,
          readBy: reader,
          readAt: readAt.toISOString(),
          status: "read"
        });
      } else if (messageDoc.chatType === "group") {
        const updatedDoc = await Message.findOne({ messageId });
        io.to(senderSocketId).emit("messageRead", {
          messageId,
          groupId: messageDoc.groupId,
          readBy: reader,
          readCount: updatedDoc.readBy.length,
          totalMembers: messageInfo ? messageInfo.totalMembers : updatedDoc.readBy.length,
          status: updatedDoc.readBy.length === (messageInfo ? messageInfo.totalMembers : updatedDoc.readBy.length) ? "read" : "delivered"
        });
      }
      console.log(`✅ Notified sender ${from} that message was read`);
    }
  });

  /**
   * Handle Disconnection
   * Removes user from maps and broadcasts offline status
   */
  socket.on("disconnect", () => {
    const username = socketUserMap.get(socket.id);

    if (username) {
      console.log(`🔴 User disconnected: ${username} (${socket.id})`);

      // Remove from all groups
      if (userRooms.has(socket.id)) {
        const userGroups = Array.from(userRooms.get(socket.id));
        userGroups.forEach(groupName => {
          if (rooms.has(groupName)) {
            const groupId = groupIds.get(groupName);
            rooms.get(groupName).delete(socket.id);
            
            // Remove from group members
            if (groupId && groupMembers.has(groupId)) {
              groupMembers.get(groupId).delete(username);
            }
            
            // Notify group members
            socket.to(groupName).emit("userLeftGroup", {
              groupName,
              username
            });

            // Remove empty groups
            if (rooms.get(groupName).size === 0) {
              rooms.delete(groupName);
              if (groupId) {
                groupIds.delete(groupName);
                groupMembers.delete(groupId);
              }
            }
          }
        });
        userRooms.delete(socket.id);
      }

      // Remove from maps
      userSocketMap.delete(username);
      socketUserMap.delete(socket.id);

      // Broadcast updated user list
      broadcastUserList();

      // Broadcast updated group list
      broadcastGroupList();

      // Broadcast offline status
      io.emit("userStatus", {
        username,
        status: "offline"
      });
    } else {
      console.log(`🔴 Client disconnected: ${socket.id}`);
    }
  });
});

/**
 * Broadcast updated user list to all connected clients
 */
function broadcastUserList() {
  const users = Array.from(userSocketMap.keys());
  io.emit("userList", { users });
}

/**
 * Broadcast updated group list to all connected clients
 */
function broadcastGroupList() {
  const groups = Array.from(rooms.keys()).map(groupName => {
    const groupId = groupIds.get(groupName);
    const members = Array.from(rooms.get(groupName))
      .map(socketId => socketUserMap.get(socketId))
      .filter(Boolean);
    return {
      name: groupName,
      groupId: groupId,
      memberCount: members.length,
      members
    };
  });
  io.emit("groupList", { groups });
}

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO server ready for connections`);
});
