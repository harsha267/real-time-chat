require("dotenv").config();
const mongoose = require("mongoose");

// Force local MongoDB for now
const mongoUri = "mongodb://localhost:27017/real-time-chat";

mongoose.connect(mongoUri);

mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB connected");
});

mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB error:", err);
});

const messageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true },
  from: { type: String, required: true },
  to: String, // For private messages
  groupId: String, // For group messages
  groupName: String, // For group messages
  chatType: { type: String, enum: ["private", "group"], required: true },
  text: { type: String, required: true },
  status: { 
    type: String, 
    enum: ["sent", "delivered", "read"], 
    default: "sent",
    required: true 
  },
  timestamp: { type: Date, default: Date.now },
  deliveredAt: Date,
  readAt: Date,
  deliveredTo: [String], // Array of usernames who received (for groups)
  readBy: [String] // Array of usernames who read (for groups)
}, {
  timestamps: true
});

// Index for faster queries
messageSchema.index({ messageId: 1 });
messageSchema.index({ from: 1, to: 1 });
messageSchema.index({ groupId: 1 });

module.exports = mongoose.model("Message", messageSchema);
