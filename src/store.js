/*
 * Storage for the shared app state: settings, stock file, and the two saved orders.
 * Uses MongoDB when MONGODB_URI is set (production on Render),
 * otherwise a JSON file in ./data (local development).
 */
const fs = require("fs");
const path = require("path");

const KEYS = ["settings", "stock", "plan-HR", "plan-NGO"];

function fileStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
  return {
    kind: "file",
    async getAll() { return read(); },
    async put(key, data) {
      const all = read();
      all[key] = { data, updatedAt: Date.now() };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all));
      return all[key];
    }
  };
}

async function mongoStore(uri) {
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(uri);
  await client.connect();
  const col = client.db(process.env.MONGODB_DB || "cpl2").collection("state");
  return {
    kind: "mongodb",
    async getAll() {
      const docs = await col.find({ _id: { $in: KEYS } }).toArray();
      const out = {};
      docs.forEach(d => { out[d._id] = { data: d.data, updatedAt: d.updatedAt }; });
      return out;
    },
    async put(key, data) {
      const doc = { data, updatedAt: Date.now() };
      await col.updateOne({ _id: key }, { $set: doc }, { upsert: true });
      return doc;
    }
  };
}

async function createStore() {
  if (process.env.MONGODB_URI) return mongoStore(process.env.MONGODB_URI);
  return fileStore(path.join(__dirname, "..", "data", "state.json"));
}

module.exports = { createStore, KEYS };
