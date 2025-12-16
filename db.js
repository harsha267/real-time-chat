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
  user: String,
  text: String,
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Message", messageSchema);
