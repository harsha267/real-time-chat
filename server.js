require("dotenv").config();
const WebSocket = require("ws");
const Message = require("./db");

const wss = new WebSocket.Server({ port: 8080 });

const users = new Map();   // username -> ws
const rooms = {};          // roomName -> Set(ws)

console.log("🚀 WebSocket running on ws://localhost:8080");

wss.on("connection", (ws) => {
  console.log("🟢 Client connected");

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === "register") {
        ws.username = msg.username;
        users.set(msg.username, ws);

        ws.send(JSON.stringify({
          type: "status",
          text: "Registered successfully"
        }));
        return;
      }

      if (msg.type === "private") {
        await Message.create({
          user: msg.from,
          text: msg.text,
          room: `private:${msg.from}-${msg.to}`
        });

        const receiver = users.get(msg.to);
        if (receiver && receiver.readyState === WebSocket.OPEN) {
          receiver.send(JSON.stringify(msg));
        }
        return;
      }

      if (msg.type === "joinRoom") {
        if (!rooms[msg.room]) rooms[msg.room] = new Set();
        rooms[msg.room].add(ws);
        ws.room = msg.room;

        ws.send(JSON.stringify({
          type: "status",
          text: `Joined room: ${msg.room}`
        }));
        return;
      }

      if (msg.type === "room") {
        await Message.create({
          user: msg.user,
          text: msg.text,
          room: msg.room
        });

        rooms[msg.room]?.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
          }
        });
        return;
      }

      if (msg.type === "global") {
        await Message.create({
          user: msg.user,
          text: msg.text,
          room: "global"
        });

        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
          }
        });
      }

    } catch (err) {
      console.error("❌ Message handling error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("🔴 Client disconnected");

    if (ws.username) users.delete(ws.username);
    if (ws.room && rooms[ws.room]) {
      rooms[ws.room].delete(ws);
    }
  });
});
