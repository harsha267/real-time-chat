/**
 * Real-Time Chat Application - Client Side
 * Socket.IO Event Flow:
 * 1. Client connects -> 'connection' event on server
 * 2. Client registers -> 'register' event -> server responds with 'registered'
 * 3. Server broadcasts -> 'userList' event (list of online users)
 * 4. Client sends message -> 'privateMessage' event -> server routes to receiver
 * 5. Receiver gets message -> 'privateMessage' event
 * 6. Client disconnects -> 'disconnect' event -> server removes user and broadcasts
 */

// Initialize Socket.IO connection
const socket = io();

// DOM Elements
const usernameInput = document.getElementById("usernameInput");
const registerBtn = document.getElementById("registerBtn");
const registrationError = document.getElementById("registrationError");
const userRegistration = document.getElementById("userRegistration");
const currentUserElement = document.getElementById("currentUser");
const currentUsername = document.getElementById("currentUsername");
const usersList = document.getElementById("usersList");
const groupsList = document.getElementById("groupsList");
const messagesContainer = document.getElementById("messagesContainer");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const inputContainer = document.getElementById("inputContainer");
const connectionStatus = document.getElementById("connectionStatus");
const statusText = document.getElementById("statusText");
const statusDot = connectionStatus.querySelector(".status-dot");
const chatHeaderContent = document.getElementById("chatHeaderContent");

// Application State
let currentUser = null;
let selectedUser = null;
let selectedGroup = null;
let chatType = null; // 'private' or 'group'
let messages = [];
let groups = [];

/**
 * Socket.IO Event Handlers
 */

// Connection established
socket.on("connect", () => {
  console.log("✅ Connected to server:", socket.id);
  updateConnectionStatus("online", "Connected");
});

// Connection lost
socket.on("disconnect", () => {
  console.log("❌ Disconnected from server");
  updateConnectionStatus("offline", "Disconnected");
});

// Connection error
socket.on("connect_error", (error) => {
  console.error("Connection error:", error);
  updateConnectionStatus("offline", "Connection Error");
});

// Registration successful
socket.on("registered", (data) => {
  console.log("✅ Registered:", data);
  currentUser = data.username;
  showUserInterface();
  hideRegistration();
  displayMessage("system", `Welcome, ${data.username}!`);
});

// Registration error
socket.on("error", (data) => {
  console.error("Error:", data.message);
  
  // Check if it's a group error
  if (createGroupModal && createGroupModal.style.display !== "none") {
    showGroupError(data.message);
    createGroupSubmitBtn.disabled = false;
    createGroupSubmitBtn.textContent = "Create/Join";
  } else if (userManagementModal && userManagementModal.style.display !== "none") {
    showUserManagementError(data.message);
    userManagementSubmitBtn.disabled = false;
    userManagementSubmitBtn.textContent = "Confirm";
  } else {
    showError(data.message);
  }
});

// Receive user list
socket.on("userList", (data) => {
  console.log("👥 User list:", data.users);
  renderUserList(data.users);
});

// User status change (online/offline)
socket.on("userStatus", (data) => {
  console.log(`👤 User ${data.username} is now ${data.status}`);
  // Refresh user list when status changes
  socket.emit("getUsers");
});

// Receive private message
socket.on("privateMessage", (data) => {
  console.log("📨 Received private message:", data);
  
  // Add message to messages array
  const message = {
    ...data,
    type: "received",
    chatType: "private",
    timestamp: data.timestamp || new Date().toISOString(),
    status: data.status || "sent"
  };
  
  messages.push(message);

  // Immediately emit message_delivered to confirm receipt
  if (data.id && data.from) {
    console.log("📬 Emitting message_delivered for:", data.id);
    socket.emit("message_delivered", {
      messageId: data.id,
      from: data.from
    });
  }

  // If message is from selected user, display it
  if (selectedUser === data.from && chatType === "private") {
    renderMessages();
    scrollToBottom();
    
    // Mark message as read if viewing the conversation (with a small delay to ensure it's rendered)
    if (data.id && data.from) {
      setTimeout(() => {
        markMessageAsRead(data.id, data.from);
      }, 200);
    }
  } else {
    // Show notification or highlight user in list
    highlightUserInList(data.from);
  }
});

// Receive group message
socket.on("groupMessage", (data) => {
  console.log("📢 Received group message:", data);
  
  // Add message to messages array
  const message = {
    ...data,
    type: "received",
    chatType: "group",
    timestamp: data.timestamp || new Date().toISOString(),
    status: data.status || "sent"
  };
  
  messages.push(message);

  // Immediately emit message_delivered to confirm receipt
  if (data.id && data.from) {
    console.log("📬 Emitting message_delivered for group message:", data.id);
    socket.emit("message_delivered", {
      messageId: data.id,
      from: data.from
    });
  }

  // If message is from selected group, display it
  if (selectedGroup === data.groupName && chatType === "group") {
    renderMessages();
    scrollToBottom();
    
    // Mark message as read if viewing the group
    if (data.id && data.from) {
      setTimeout(() => {
        markMessageAsRead(data.id, data.from);
      }, 200);
    }
  } else {
    // Show notification or highlight group in list
    highlightGroupInList(data.groupName);
  }
});

// Group joined
socket.on("groupJoined", (data) => {
  console.log("✅ Joined group:", data);
  
  // Reset button state
  createGroupSubmitBtn.disabled = false;
  createGroupSubmitBtn.textContent = "Create/Join";
  
  createGroupModal.style.display = "none";
  groupNameInput.value = "";
  document.getElementById("groupError").classList.remove("show");
  
  // Refresh groups list
  socket.emit("getGroups");
  socket.emit("getMyGroups");
  
  // Auto-select the group after a brief delay to ensure list is updated
  setTimeout(() => {
    selectGroup(data.groupName);
  }, 200);
});

// Group left
socket.on("groupLeft", (data) => {
  console.log("👋 Left group:", data);
  if (selectedGroup === data.groupName) {
    selectedGroup = null;
    chatType = null;
    chatHeaderContent.innerHTML = "<h2>Select a user or group to start chatting</h2>";
    messagesContainer.innerHTML = '<div class="welcome-message"><p>Select a user or group to start chatting.</p></div>';
    sendBtn.disabled = true;
  }
  socket.emit("getGroups");
  socket.emit("getMyGroups");
});

// User joined group
socket.on("userJoinedGroup", (data) => {
  console.log("👤 User joined group:", data);
  socket.emit("getGroups");
});

// User left group
socket.on("userLeftGroup", (data) => {
  console.log("👤 User left group:", data);
  socket.emit("getGroups");
});

// Receive group list
socket.on("groupList", (data) => {
  console.log("📦 Group list:", data.groups);
  groups = data.groups;
  renderGroupList();
});

// User added to group
socket.on("userAddedToGroup", (data) => {
  console.log("➕ User added to group:", data);
  socket.emit("getGroups");
  if (selectedGroup === data.groupName) {
    // Update chat header with new member count
    const group = groups.find(g => g.name === data.groupName);
    if (group) {
      chatHeaderContent.innerHTML = `
        <div class="chat-with">
          <span class="user-avatar">👥</span>
          <h2>${data.groupName} (${data.members.length} members)</h2>
        </div>
      `;
    }
  }
});

// User removed from group
socket.on("userRemovedFromGroup", (data) => {
  console.log("➖ User removed from group:", data);
  socket.emit("getGroups");
  if (selectedGroup === data.groupName) {
    const group = groups.find(g => g.name === data.groupName);
    if (group) {
      chatHeaderContent.innerHTML = `
        <div class="chat-with">
          <span class="user-avatar">👥</span>
          <h2>${data.groupName} (${data.members.length} members)</h2>
        </div>
      `;
    }
  }
});

// Removed from group notification
socket.on("removedFromGroup", (data) => {
  console.log("🚫 Removed from group:", data);
  if (selectedGroup === data.groupName) {
    selectedGroup = null;
    chatType = null;
    chatHeaderContent.innerHTML = "<h2>Select a user or group to start chatting</h2>";
    messagesContainer.innerHTML = '<div class="welcome-message"><p>You were removed from this group.</p></div>';
    sendBtn.disabled = true;
  }
  socket.emit("getGroups");
});

// Receive my groups
socket.on("myGroups", (data) => {
  console.log("📦 My groups:", data.groups);
  // Could use this to highlight groups user is in
});

// Message sent confirmation
socket.on("messageSent", (data) => {
  console.log("✅ Message sent:", data);
  // Update message in array with ID from server
  if (data.message && data.message.id) {
    // Try to find by temp ID first
    let messageIndex = messages.findIndex(m => 
      m.id && m.id.startsWith('temp-') &&
      m.text === data.message.text && 
      m.from === data.message.from && 
      m.to === data.message.to
    );
    
    // If not found, try without ID check
    if (messageIndex === -1) {
      messageIndex = messages.findIndex(m => 
        m.text === data.message.text && 
        m.from === data.message.from && 
        m.to === data.message.to &&
        !m.id
      );
    }
    
    if (messageIndex !== -1) {
      messages[messageIndex] = {
        ...messages[messageIndex],
        id: data.message.id, // Use server's ID
        status: "sent",
        delivered: false,
        read: false
      };
      console.log("Updated message with server ID:", data.message.id);
      renderMessages();
    } else {
      console.warn("Could not find message to update with server ID");
    }
  }
});

// Message delivered notification
socket.on("messageDelivered", (data) => {
  console.log("📬 Message delivered:", data);
  
  const messageIndex = messages.findIndex(m => m.id === data.messageId);
  if (messageIndex !== -1) {
    messages[messageIndex].status = "delivered";
    messages[messageIndex].delivered = true;
    messages[messageIndex].deliveredAt = data.deliveredAt;
    if (data.deliveredTo !== undefined) {
      messages[messageIndex].deliveredTo = data.deliveredTo;
    }
    if (data.totalMembers !== undefined) {
      messages[messageIndex].totalMembers = data.totalMembers;
    }
    renderMessages();
  }
});

// Message read notification
socket.on("messageRead", (data) => {
  console.log("👁️ Message read:", data);
  
  const messageIndex = messages.findIndex(m => m.id === data.messageId);
  if (messageIndex !== -1) {
    messages[messageIndex].status = "read";
    messages[messageIndex].read = true;
    messages[messageIndex].readAt = data.readAt;
    if (data.readBy) {
      messages[messageIndex].readBy = data.readBy;
    }
    if (data.readCount !== undefined) {
      messages[messageIndex].readCount = data.readCount;
    }
    if (data.totalMembers !== undefined) {
      messages[messageIndex].totalMembers = data.totalMembers;
    }
    renderMessages();
  }
});

/**
 * UI Event Handlers
 */

// Register button click
registerBtn.addEventListener("click", handleRegister);

// Enter key in username input
usernameInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    handleRegister();
  }
});

// Send button click
sendBtn.addEventListener("click", handleSendMessage);

// Enter key in message input
messageInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSendMessage();
  }
});

// Enable/disable send button based on input and selected user
messageInput.addEventListener("input", () => {
  updateSendButtonState();
});

// Tab switching
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    switchTab(tab);
  });
});

// Group creation
const createGroupBtn = document.getElementById("createGroupBtn");
const createGroupModal = document.getElementById("createGroupModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const groupNameInput = document.getElementById("groupNameInput");
const createGroupSubmitBtn = document.getElementById("createGroupSubmitBtn");
const addUserBtn = document.getElementById("addUserBtn");
const removeUserBtn = document.getElementById("removeUserBtn");
const groupActions = document.getElementById("groupActions");
const userManagementModal = document.getElementById("userManagementModal");
const closeUserModalBtn = document.getElementById("closeUserModalBtn");
const usernameInputModal = document.getElementById("usernameInputModal");
const userManagementSubmitBtn = document.getElementById("userManagementSubmitBtn");
const userManagementTitle = document.getElementById("userManagementTitle");
let userManagementMode = "add"; // "add" or "remove"

createGroupBtn.addEventListener("click", () => {
  createGroupModal.style.display = "flex";
  groupNameInput.focus();
});

// Add user to group
addUserBtn.addEventListener("click", () => {
  userManagementMode = "add";
  userManagementTitle.textContent = "Add User to Group";
  usernameInputModal.placeholder = "Enter username to add";
  userManagementModal.style.display = "flex";
  usernameInputModal.focus();
});

// Remove user from group
removeUserBtn.addEventListener("click", () => {
  userManagementMode = "remove";
  userManagementTitle.textContent = "Remove User from Group";
  usernameInputModal.placeholder = "Enter username to remove";
  userManagementModal.style.display = "flex";
  usernameInputModal.focus();
});

closeUserModalBtn.addEventListener("click", () => {
  userManagementModal.style.display = "none";
  usernameInputModal.value = "";
  document.getElementById("userManagementError").classList.remove("show");
});

userManagementModal.addEventListener("click", (e) => {
  if (e.target === userManagementModal) {
    userManagementModal.style.display = "none";
    usernameInputModal.value = "";
    document.getElementById("userManagementError").classList.remove("show");
  }
});

userManagementSubmitBtn.addEventListener("click", handleUserManagement);
usernameInputModal.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    handleUserManagement();
  }
});

function handleUserManagement() {
  const username = usernameInputModal.value.trim();

  if (!username) {
    showUserManagementError("Please enter a username");
    return;
  }

  if (!selectedGroup) {
    showUserManagementError("No group selected");
    return;
  }

  if (userManagementMode === "add") {
    socket.emit("addUserToGroup", {
      groupName: selectedGroup,
      username: username
    });
  } else {
    socket.emit("removeUserFromGroup", {
      groupName: selectedGroup,
      username: username
    });
  }

  userManagementModal.style.display = "none";
  usernameInputModal.value = "";
  userManagementSubmitBtn.disabled = true;
  userManagementSubmitBtn.textContent = "Processing...";
  
  setTimeout(() => {
    userManagementSubmitBtn.disabled = false;
    userManagementSubmitBtn.textContent = "Confirm";
  }, 2000);
}

function showUserManagementError(message) {
  const errorEl = document.getElementById("userManagementError");
  errorEl.textContent = message;
  errorEl.classList.add("show");
  setTimeout(() => {
    errorEl.classList.remove("show");
  }, 5000);
}

closeModalBtn.addEventListener("click", () => {
  createGroupModal.style.display = "none";
  groupNameInput.value = "";
  document.getElementById("groupError").classList.remove("show");
});

createGroupModal.addEventListener("click", (e) => {
  if (e.target === createGroupModal) {
    createGroupModal.style.display = "none";
    groupNameInput.value = "";
    document.getElementById("groupError").classList.remove("show");
  }
});

createGroupSubmitBtn.addEventListener("click", handleCreateGroup);
groupNameInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    handleCreateGroup();
  }
});

function updateSendButtonState() {
  const hasSelection = (chatType === "private" && selectedUser !== null) || 
                       (chatType === "group" && selectedGroup !== null);
  // Enable button when a user/group is selected (text validation happens in send function)
  sendBtn.disabled = !hasSelection;
  
  // Debug logging
  console.log("Button state updated - Chat type:", chatType, "Button disabled:", sendBtn.disabled);
}

/**
 * Functions
 */

// Handle user registration
function handleRegister() {
  const username = usernameInput.value.trim();

  if (!username) {
    showError("Please enter a username");
    return;
  }

  if (username.length < 2) {
    showError("Username must be at least 2 characters");
    return;
  }

  // Emit register event to server
  socket.emit("register", { username });
}

// Handle sending message
function handleSendMessage() {
  const text = messageInput.value.trim();

  if (!text) {
    return;
  }

  if (chatType === "private" && selectedUser) {
    const messageData = {
      to: selectedUser,
      text: text
    };

    // Generate temporary ID (will be replaced by server)
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Add message to local array immediately (optimistic update)
    const message = {
      id: tempId,
      from: currentUser,
      to: selectedUser,
      text: text,
      type: "sent",
      chatType: "private",
      timestamp: new Date().toISOString(),
      status: "sent",
      delivered: false,
      read: false
    };

    messages.push(message);
    renderMessages();
    scrollToBottom();

    // Clear input
    messageInput.value = "";
    updateSendButtonState();

    // Emit private message event to server
    socket.emit("privateMessage", messageData);
  } else if (chatType === "group" && selectedGroup) {
    const messageData = {
      groupName: selectedGroup,
      text: text
    };

    // Generate temporary ID (will be replaced by server)
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Add message to local array immediately (optimistic update)
    const message = {
      id: tempId,
      from: currentUser,
      groupName: selectedGroup,
      text: text,
      type: "sent",
      chatType: "group",
      timestamp: new Date().toISOString(),
      status: "sent",
      deliveredTo: 0,
      readCount: 0
    };

    messages.push(message);
    renderMessages();
    scrollToBottom();

    // Clear input
    messageInput.value = "";
    updateSendButtonState();

    // Emit group message event to server
    socket.emit("groupMessage", messageData);
  }
}

// Show user interface after registration
function showUserInterface() {
  currentUsername.textContent = currentUser;
  currentUserElement.style.display = "block";
  inputContainer.style.display = "block";
  socket.emit("getUsers");
  socket.emit("getGroups");
  socket.emit("getMyGroups");
}

// Hide registration form
function hideRegistration() {
  userRegistration.style.display = "none";
}

// Show error message
function showError(message) {
  registrationError.textContent = message;
  registrationError.classList.add("show");
  setTimeout(() => {
    registrationError.classList.remove("show");
  }, 5000);
}

// Update connection status
function updateConnectionStatus(status, text) {
  statusDot.className = `status-dot ${status}`;
  statusText.textContent = text;
}

// Render user list
function renderUserList(users) {
  // Filter out current user
  const otherUsers = users.filter(user => user !== currentUser);

  if (otherUsers.length === 0) {
    usersList.innerHTML = '<p class="empty-state">No other users online</p>';
    return;
  }

  usersList.innerHTML = otherUsers.map(user => `
    <div class="user-item ${selectedUser === user ? 'active' : ''}" data-username="${user}">
      <span class="user-avatar">👤</span>
      <span class="username">${user}</span>
      <span class="online-indicator"></span>
    </div>
  `).join("");

  // Add click handlers
  usersList.querySelectorAll(".user-item").forEach(item => {
    item.addEventListener("click", () => {
      const username = item.dataset.username;
      selectUser(username);
    });
  });
}

// Select user to chat with
function selectUser(username) {
  console.log("Selecting user:", username);
  selectedUser = username;
  selectedGroup = null;
  chatType = "private";
  
  // Update UI
  document.querySelectorAll(".user-item").forEach(item => {
    item.classList.toggle("active", item.dataset.username === username);
  });
  document.querySelectorAll(".group-item").forEach(item => {
    item.classList.remove("active");
  });

  // Update chat header
  chatHeaderContent.innerHTML = `
    <div class="chat-with">
      <span class="user-avatar">👤</span>
      <h2>Chatting with ${username}</h2>
    </div>
  `;
  
  // Hide group actions
  groupActions.style.display = "none";

  // Filter and render messages for this conversation
  renderMessages();
  scrollToBottom();

  // Mark all unread messages from this user as seen
  markUnreadMessagesAsSeen(username);

  // Enable input and update button state
  messageInput.focus();
  updateSendButtonState();
  
  console.log("User selected, button state:", sendBtn.disabled ? "disabled" : "enabled");
}

// Select group to chat with
function selectGroup(groupName) {
  console.log("Selecting group:", groupName);
  selectedGroup = groupName;
  selectedUser = null;
  chatType = "group";
  
  // Update UI
  document.querySelectorAll(".group-item").forEach(item => {
    item.classList.toggle("active", item.dataset.groupname === groupName);
  });
  document.querySelectorAll(".user-item").forEach(item => {
    item.classList.remove("active");
  });

  // Update chat header
  const group = groups.find(g => g.name === groupName);
  const memberCount = group ? group.memberCount : 0;
  chatHeaderContent.innerHTML = `
    <div class="chat-with">
      <span class="user-avatar">👥</span>
      <h2>${groupName} (${memberCount} members)</h2>
    </div>
  `;
  
  // Show group actions
  groupActions.style.display = "flex";

  // Filter and render messages for this conversation
  renderMessages();
  scrollToBottom();

  // Enable input and update button state
  messageInput.focus();
  updateSendButtonState();
  
  console.log("Group selected, button state:", sendBtn.disabled ? "disabled" : "enabled");
}

// Handle create/join group
function handleCreateGroup() {
  const groupName = groupNameInput.value.trim();

  if (!groupName) {
    showGroupError("Please enter a group name");
    return;
  }

  if (groupName.length < 2) {
    showGroupError("Group name must be at least 2 characters");
    return;
  }

  if (groupName.length > 30) {
    showGroupError("Group name must be less than 30 characters");
    return;
  }

  console.log("Creating/joining group:", groupName);
  socket.emit("joinGroup", { groupName });
  
  // Show loading state
  createGroupSubmitBtn.disabled = true;
  createGroupSubmitBtn.textContent = "Joining...";
}

function showGroupError(message) {
  const errorEl = document.getElementById("groupError");
  errorEl.textContent = message;
  errorEl.classList.add("show");
  setTimeout(() => {
    errorEl.classList.remove("show");
  }, 5000);
}

// Switch tabs
function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  if (tab === "users") {
    document.getElementById("usersSection").style.display = "block";
    document.getElementById("groupsSection").style.display = "none";
  } else {
    document.getElementById("usersSection").style.display = "none";
    document.getElementById("groupsSection").style.display = "block";
    socket.emit("getGroups");
  }
}

// Render group list
function renderGroupList() {
  if (!groupsList) {
    console.error("groupsList element not found");
    return;
  }

  if (groups.length === 0) {
    groupsList.innerHTML = '<p class="empty-state">No groups available. Create one!</p>';
    return;
  }

  groupsList.innerHTML = groups.map(group => `
    <div class="group-item ${selectedGroup === group.name ? 'active' : ''}" data-groupname="${group.name}">
      <span class="group-icon">👥</span>
      <div class="group-info">
        <div class="group-name">${group.name}</div>
        <div class="group-members">${group.memberCount} member${group.memberCount !== 1 ? 's' : ''}</div>
      </div>
    </div>
  `).join("");

  // Add click handlers
  groupsList.querySelectorAll(".group-item").forEach(item => {
    item.addEventListener("click", () => {
      const groupName = item.dataset.groupname;
      selectGroup(groupName);
    });
  });
}

// Highlight group in list
function highlightGroupInList(groupName) {
  const groupItem = groupsList.querySelector(`[data-groupname="${groupName}"]`);
  if (groupItem) {
    groupItem.style.animation = "pulse 1s ease-in-out";
    setTimeout(() => {
      groupItem.style.animation = "";
    }, 1000);
  }
}

// Render messages
function renderMessages() {
  if (chatType === "private" && !selectedUser) {
    return;
  }
  if (chatType === "group" && !selectedGroup) {
    return;
  }

  // Filter messages for current conversation
  let conversationMessages = [];
  
  if (chatType === "private") {
    conversationMessages = messages.filter(msg => 
      msg.chatType === "private" &&
      ((msg.from === currentUser && msg.to === selectedUser) ||
       (msg.from === selectedUser && msg.to === currentUser))
    );
  } else if (chatType === "group") {
    conversationMessages = messages.filter(msg => 
      msg.chatType === "group" && msg.groupName === selectedGroup
    );
  }

  if (conversationMessages.length === 0) {
    messagesContainer.innerHTML = `
      <div class="welcome-message">
        <p>No messages yet. Start the conversation!</p>
      </div>
    `;
    return;
  }

  messagesContainer.innerHTML = conversationMessages.map(msg => {
    const isSent = msg.type === "sent" || msg.from === currentUser;
    const timestamp = formatTimestamp(msg.timestamp);
    const senderName = isSent ? "You" : msg.from;
    
    // Message status indicator for sent messages
    let statusIndicator = "";
    if (isSent) {
      const status = msg.status || (msg.read ? "read" : msg.delivered ? "delivered" : "sent");
      
      if (chatType === "private") {
        // Private message status
        if (status === "read") {
          statusIndicator = '<span class="read-indicator" title="Read">✓✓</span>';
        } else if (status === "delivered") {
          statusIndicator = '<span class="delivered-indicator" title="Delivered">✓✓</span>';
        } else {
          statusIndicator = '<span class="sent-indicator" title="Sent">✓</span>';
        }
      } else if (chatType === "group") {
        // Group message status
        const readCount = msg.readCount || 0;
        const totalMembers = msg.totalMembers || 1;
        const deliveredTo = msg.deliveredTo || 0;
        
        if (status === "read" && readCount === totalMembers) {
          statusIndicator = `<span class="read-indicator" title="Read by all (${readCount}/${totalMembers})">✓✓</span>`;
        } else if (status === "delivered" || deliveredTo > 0) {
          statusIndicator = `<span class="delivered-indicator" title="Delivered to ${deliveredTo}/${totalMembers}">✓✓</span>`;
        } else {
          statusIndicator = '<span class="sent-indicator" title="Sent">✓</span>';
        }
      }
    }
    
    return `
      <div class="message ${isSent ? 'sent' : 'received'}" data-message-id="${msg.id || ''}">
        <div class="message-header">
          <span>${senderName}</span>
          ${chatType === "group" && !isSent ? `<span style="font-size: 10px; opacity: 0.7;">in ${msg.groupName}</span>` : ''}
        </div>
        <div class="message-text">${escapeHtml(msg.text)}</div>
        <div class="message-footer">
          <div class="message-time">${timestamp}</div>
          ${statusIndicator}
        </div>
      </div>
    `;
  }).join("");

  scrollToBottom();
  
  // Mark unread received messages as seen when they're displayed
  if (chatType === "private" && selectedUser) {
    conversationMessages.forEach(msg => {
      const isSentMsg = msg.type === "sent" || msg.from === currentUser;
      if (!isSentMsg && msg.from === selectedUser && msg.id && !msg.read) {
        console.log("Marking message as read:", msg.id);
        markMessageAsRead(msg.id, msg.from);
        // Optimistically update
        msg.read = true;
        msg.status = "read";
      }
    });
  }
}

// Mark message as read
function markMessageAsRead(messageId, from) {
  if (!messageId || !from) return;
  
  console.log("👁️ Emitting message_read for:", messageId);
  socket.emit("message_read", {
    messageId,
    from
  });
}

// Mark all unread messages from a user as read
function markUnreadMessagesAsSeen(username) {
  messages.forEach(msg => {
    if (msg.chatType === "private" && 
        msg.from === username && 
        msg.to === currentUser && 
        msg.id && 
        !msg.read) {
      markMessageAsRead(msg.id, username);
      msg.read = true; // Optimistic update
      msg.status = "read";
    }
  });
}

// Display system message
function displayMessage(type, text) {
  const message = document.createElement("div");
  message.className = `message ${type}`;
  message.innerHTML = `
    <div class="message-text">${escapeHtml(text)}</div>
  `;
  messagesContainer.appendChild(message);
  scrollToBottom();
}

// Scroll to bottom of messages
function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Format timestamp
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;

  return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Highlight user in list (when receiving message from non-selected user)
function highlightUserInList(username) {
  const userItem = usersList.querySelector(`[data-username="${username}"]`);
  if (userItem) {
    userItem.style.animation = "pulse 1s ease-in-out";
    setTimeout(() => {
      userItem.style.animation = "";
    }, 1000);
  }
}

// Auto-scroll on new messages
const observer = new MutationObserver(() => {
  scrollToBottom();
});

observer.observe(messagesContainer, {
  childList: true,
  subtree: true
});

